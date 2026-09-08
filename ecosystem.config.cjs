module.exports = {
  apps: [{
    name: 'astra',
    script: './index.js',
    // Auto-restart on crash (always, unlimited)
    max_restarts: 0,
    restart_delay: 5000,
    autorestart: true,
    // Watch for file changes (disabled; enable if you want auto-reload on edit)
    watch: false,
    // Memory threshold — restart if exceeds (prevents memory leak hangs)
    max_memory_restart: '500M',
    // Logs
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Environment
    node_args: [],
    env: {
      NODE_ENV: 'production'
    }
  }]
};
