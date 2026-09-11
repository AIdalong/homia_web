// PM2 部署配置：pm2 start ecosystem.config.js
// 生产环境请按需修改 PORT；如需远程写回 data/*.json，再填 ADMIN_TOKEN
module.exports = {
  apps: [
    {
      name: 'homia-web',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3899
        // 默认关闭远程配置写入；打开后请求需带 x-admin-token 头
        // ADMIN_TOKEN: 'change-me-to-a-random-string'
      }
    }
  ]
};
