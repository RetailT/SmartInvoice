require('dotenv').config();
const { connectToDatabase } = require('./config/db'); // Your database connection module
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const axios = require("axios");
const querystring = require("querystring");
const readline = require("readline");
const { Readable } = require('stream');

// === CONFIG ===
const POLL_INTERVAL = 10000; // Poll the database every 10 seconds (in milliseconds)
const posmain = process.env.DB_DATABASE1; // Database name from .env
const CREDENTIALS_PATH = process.env.CLIENT_SECRET; // Google API credentials
const TOKEN_PATH = process.env.TOKEN_PATH; // File to store Google API tokens
const FOLDER_PATH = process.env.FOLDER_NAME || 'SmartInvoices'; // Folder path for PDFs (e.g., 'Smart_Invoice/Invoices') - configurable via .env

// === GOOGLE DRIVE AUTH ===
async function authorize() {
  console.log("🔍 Starting Google Drive authentication...");
  try {
    // Load Google API credentials
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(`Credentials file not found at ${CREDENTIALS_PATH}. Please download from Google Cloud Console.`);
    }
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    const { client_secret, client_id, redirect_uris } = credentials.installed;

    // Initialize OAuth2 client
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Check if token exists
    if (fs.existsSync(TOKEN_PATH)) {
      console.log("📄 Found token.json, attempting to use it...");
      try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
        if (!token.refresh_token) {
          console.log("⚠️ token.json is missing refresh_token. Manual re-authentication required.");
          throw new Error("Missing refresh_token");
        }
        oAuth2Client.setCredentials(token);
        console.log("✅ Token loaded successfully.");

        // Test token validity by refreshing if needed
        try {
          await oAuth2Client.getAccessToken();
          console.log("✅ Token is valid or refreshed successfully.");
        } catch (refreshErr) {
          console.error("❌ Token refresh failed:", refreshErr.message);
          if (refreshErr.message.includes("invalid_grant")) {
            console.error(
              "🚨 Invalid refresh_token. Manual re-authentication needed. " +
              "Delete token.json and run the script again to re-authenticate."
            );
            throw new Error("Invalid refresh_token. Please re-authenticate manually.");
          } else {
            throw refreshErr; // Rethrow other errors
          }
        }

        // Listen for token updates (auto-refresh)
        oAuth2Client.on("tokens", (tokens) => {
          try {
            const updatedToken = { ...token, ...tokens };
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
            console.log("🔁 Token refreshed and saved to token.json.");
          } catch (writeErr) {
            console.error("❌ Failed to save updated token:", writeErr.message);
          }
        });

        return oAuth2Client;
      } catch (tokenErr) {
        console.error("❌ Error loading token.json:", tokenErr.message);
        console.log("⚠️ token.json may be corrupted or invalid. Manual re-authentication required.");
      }
    }

    // Manual authentication (only for initial setup or if token is invalid)
    console.log(
      "⚠️ No valid token.json found. Manual authentication required. " +
      "Follow the steps below to authenticate with Google."
    );
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive.file"],
      prompt: "consent", // Force refresh_token generation
    });

    console.log("🔑 Copy and paste this URL into your browser to authorize the app:\n", authUrl);
    console.log("ℹ️ After signing in, copy the code from the browser URL (it starts with '4/').");

    // Prompt user to paste the authorization code
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise((resolve) => {
      rl.question("Paste the code from the browser: ", (answer) => {
        rl.close();
        resolve(answer);
      });
    });

    // Exchange code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error("No refresh_token received. Ensure 'access_type=offline' and 'prompt=consent' in auth URL.");
    }
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("✅ New access token and refresh token saved to token.json.");

    // Listen for token updates after manual authentication
    oAuth2Client.on("tokens", (tokens) => {
      try {
        const updatedToken = { ...tokens };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
        console.log("🔁 Token refreshed and saved to token.json.");
      } catch (writeErr) {
        console.error("❌ Failed to save updated token:", writeErr.message);
      }
    });

    return oAuth2Client;
  } catch (err) {
    console.error("❌ Authorization error:", err.message);
    throw err;
  }
}

// === GET OR CREATE NESTED FOLDER ===
async function getOrCreateFolder(auth, folderPath) {
  try {
    const drive = google.drive({ version: "v3", auth });
    const folderNames = folderPath.split('/').filter(name => name.trim() !== ''); // Split by '/' and ignore empty parts

    let currentParentId = null; // Start from root

    for (const folderName of folderNames) {
      // Search for existing folder in current parent
      const res = await drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${currentParentId ? ` and '${currentParentId}' in parents` : ''}`,
        fields: "files(id, name)",
      });

      let folderId;
      if (res.data.files && res.data.files.length > 0) {
        folderId = res.data.files[0].id;
        console.log(`📁 Found existing folder: ${folderName} (ID: ${folderId})`);
      } else {
        // Create new folder
        console.log(`📁 Creating new folder: ${folderName}`);
        const folder = await drive.files.create({
          resource: {
            name: folderName,
            ...(currentParentId && { parents: [currentParentId] }), // Set parent if not root
            mimeType: "application/vnd.google-apps.folder",
          },
          fields: "id",
        });
        folderId = folder.data.id;
        console.log(`✅ Folder created: ${folderName} (ID: ${folderId})`);
      }

      currentParentId = folderId; // This becomes parent for next level
    }

    console.log(`📁 Final folder path ready: ${folderPath} (ID: ${currentParentId})`);
    return currentParentId;
  } catch (err) {
    console.error("❌ Error getting/creating folder:", err.message);
    throw err;
  }
}

// === UPLOAD FILE TO GOOGLE DRIVE ===
async function uploadToDrive(auth, pdfBuffer, fileName, folderId) {
  try {
    const drive = google.drive({ version: "v3", auth });

    // Upload the PDF buffer to the specified folder
    const file = await drive.files.create({
      resource: { 
        name: fileName,
        parents: [folderId] // Place file in the folder
      },
      media: {
        mimeType: "application/pdf",
        body: Readable.from(pdfBuffer),
      },
      fields: "id, webViewLink",
    });

    // Make the file publicly accessible
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: "reader", type: "anyone" },
    });

    console.log("✅ File uploaded to Google Drive:", file.data.webViewLink);
    
    return file.data.webViewLink;
  } catch (err) {
    console.error("❌ Error uploading to Google Drive:", err.message);
    throw err;
  }
}

// === SEND SMS ===
async function sendSMS(phone, customerID, link) {
  try {
    console.log("📡 Connecting to database...");
    const pool = await connectToDatabase();

    // Query the database for customer
    const result = await pool
      .request()
      .input("customerID", customerID)
      .query(`
        USE [${posmain}];
        SELECT * FROM tb_SMS_MAIN WHERE CUSTOMER_ID = @customerID;
      `);

    if (!result.recordset.length) {
      console.warn("⚠️ No customer found for ID:", customerID);
      return;
    }
    else if(result.recordset[0].SMARTINVOICE_ACTIVE==='T'){
      console.log('smart invoice active');
      const smsUser = result.recordset[0].SMS_USERNAME?.trim();
      const smsPassword = result.recordset[0].SMS_PASSWORD?.trim();

      // Prepare and send SMS
      const text = `Dear customer, your bill is available at: ${link}`;
      const encodedText = querystring.escape(text);
      const url = `https://textit.biz/sendmsg/?id=${smsUser}&pw=${smsPassword}&to=${phone}&text=${encodedText}`;

      const response = await axios.get(url);
      const responseText = response.data.trim();

      const res = responseText.split(":");

      if (res[0].trim() === "OK") {
        console.log("✅ SMS Sent - ID:", res[1]);

        // Log to tb_SMS_LOG after successful send
        await pool.request()
          .input("customerID", customerID)
          .input("smsUser", smsUser)
          .input("smsPassword", smsPassword)
          .input("phoneNumber", phone)
          .input("url", link)
          .query(`
            USE [${posmain}];
            INSERT INTO tb_SMS_LOG (CUSTOMER_ID, SMS_USER, SMS_PASSWORD, PHONE_NUMBER, URL)
            VALUES (@customerID, @smsUser, @smsPassword, @phoneNumber, @url);
          `);
        console.log("✅ Logged to tb_SMS_LOG");
      } else {
        console.log("❌ SMS Failed - Reason:", res[1]);
      }
    }
    else{
      console.warn("⚠️ Smart Invoice not active for customer id:", customerID);
      return;
    }
  } catch (err) {
    console.error("❌ Error sending SMS:", err.message);
  }
}

async function deleteOldFiles(auth, folderId) {
  const drive = google.drive({ version: "v3", auth });

  try {
    // Get current date and calculate date for one week ago
    const currentDate = new Date();
    const oneWeekAgo = new Date(currentDate);
    oneWeekAgo.setDate(currentDate.getDate() - 7); // 7 days ago

    // List PDF files only in the specified folder
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
      fields: "files(id, name, createdTime)",
      orderBy: "createdTime desc",
    });

    // Iterate over files and check if they are older than one week
    for (const file of res.data.files) {
      const fileCreatedTime = new Date(file.createdTime);

      // If the file is older than one week, delete it
      if (fileCreatedTime < oneWeekAgo) {
        console.log(`🗑️ Deleting file: ${file.name} (ID: ${file.id})`);
        await drive.files.delete({
          fileId: file.id,
        });
        console.log(`✅ File deleted: ${file.name}`);
      }
    }
  } catch (err) {
    console.error("❌ Error deleting old files:", err.message);
  }
}

// === MAIN POLLER ===
(async () => {
  try {
    // Authenticate with Google Drive
    const auth = await authorize();
    const folderId = await getOrCreateFolder(auth, FOLDER_PATH);
    console.log(`📂 Polling database table: tb_SMART_INVOICE`);
    console.log(`📁 Using Google Drive folder path: ${FOLDER_PATH} (Final ID: ${folderId})`);

    // Schedule to delete old files once a day (only in the final folder)
    setInterval(async () => {
      await deleteOldFiles(auth, folderId);
    }, 24 * 60 * 60 * 1000); // Every 24 hours (in milliseconds)

    // Poll the database for new PDFs where DOWNLOAD = 'F'
    setInterval(async () => {
      try {
        const pool = await connectToDatabase();
        const result = await pool.request().query(`
          USE [${posmain}];
          SELECT * FROM tb_SMART_INVOICE WHERE DOWNLOAD = 'F';
        `);

        for (const row of result.recordset) {
          try {
            const customerID = row.CUSTOMERID;
            const rawPhone = row.MOBILENO;

            // Validate and format phone number
            let customerPhone = null;
            if (/^94\d{9}$/.test(rawPhone)) {
              customerPhone = "0" + rawPhone.slice(2);
            } else if (/^0\d{9}$/.test(rawPhone)) {
              customerPhone = rawPhone;
            } else {
              console.warn("⚠️ Invalid phone number:", rawPhone);
              continue;
            }

            const fileName = row.FILENAME;
            const pdfBuffer = row.PDFDATA;

            console.log(`📄 New PDF detected in DB: ${fileName}`);

            // Upload PDF to Google Drive (in the final folder)
            const link = await uploadToDrive(auth, pdfBuffer, fileName, folderId);

            // Update DOWNLOAD to 'T'
            await pool.request()
              .input("idx", row.IDX)
              .query(`
                USE [${posmain}];
                UPDATE tb_SMART_INVOICE SET DOWNLOAD = 'T' WHERE IDX = @idx;
              `);
            console.log(`✅ Updated DOWNLOAD to 'T' for IDX: ${row.IDX}`);

            // Send SMS with the link
            await sendSMS(customerPhone, customerID, link);
          } catch (rowErr) {
            console.error(`❌ Error processing row IDX ${row.IDX}:`, rowErr.message);
            // Do not update DOWNLOAD on error, so it can be retried next poll
          }
        }
      } catch (pollErr) {
        console.error("❌ Polling error:", pollErr.message);
      }
    }, POLL_INTERVAL);
  } catch (err) {
    console.error("❌ Startup error:", err.message);
    process.exit(1); // Exit to stop the script if authentication fails
  }
})();