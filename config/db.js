const mssql = require('mssql');
require('dotenv').config();

// MSSQL database configuration
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE1,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  port: parseInt(process.env.PORT),
};

let pool;

const connectToDatabase = async () => {
  try {
    if (pool) {
      return pool; // Reuse existing pool
    }

    pool = await mssql.connect(dbConfig);
    console.log('✅ Connected to the MSSQL database');
    return pool;
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  }
};

module.exports = { connectToDatabase };
