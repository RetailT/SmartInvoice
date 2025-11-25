module.exports = {
  apps: [
    {
      name: "smartinvoice-sms-sender",
      script: "sms.js", // ← this file must be in the same folder
      // cwd: "/path/to/your/project", // ← REMOVE THIS LINE
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "600M",
      time: true,
      env: {
        NODE_ENV: "production",
      },
      error_file: "./logs/smartinvoice-sms-error.log",
      out_file: "./logs/smartinvoice-sms-out.log",
      log_file: "./logs/smartinvoice-sms-combined.log",
      merge_logs: true,
    },
  ],
};
