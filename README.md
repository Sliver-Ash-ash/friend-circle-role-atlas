# 朋友圈岗位图鉴

《朋友圈岗位图鉴：你在好友群里是什么工种》测评网站。前端可运行在本地
Node.js 服务，也可发布到 GitHub Pages；公网模式使用 Supabase Edge Function
和 PostgreSQL 保存测试进度、访问码额度与分享记录。

## 公网架构

- GitHub Pages：托管 `public/` 中的静态页面。
- `app-api` Edge Function：提供解锁、答题进度、提交、结果和后台接口。
- Supabase PostgreSQL：保存批次、访问码、测试、结果与分享记录。
- GitHub Actions：从仓库变量注入 Supabase URL 和 anon key，然后发布前端。
- 敏感密钥只保存在 Supabase Secrets 和本机 `.env`，不得提交到仓库。

## 首次部署

1. 在 Supabase 创建项目，并在 SQL Editor 执行
   `supabase/migrations/202610290001_init.sql`。
2. 部署 `supabase/functions/app-api`，确认函数名为 `app-api`。
3. 为 Edge Function 设置以下 Secrets：

   ```text
   SUPABASE_SERVICE_ROLE_KEY
   APP_SECRET
   ADMIN_PASSWORD
   LEGACY_LOOKUP_SECRET
   ALLOWED_ORIGINS
   ```

   `APP_SECRET` 应使用至少 32 字节的随机值。`LEGACY_LOOKUP_SECRET` 仅在迁移
   旧访问码时需要，值来自未提交的 `data/state.json` 中的 `secret`。

4. 在 GitHub 仓库的 Actions Variables 中设置公开值：

   ```text
   SUPABASE_URL
   SUPABASE_ANON_KEY
   ```

   anon key 会进入浏览器配置，这是 Supabase 的设计；service role key 绝不能放入
   GitHub Variables 或前端配置。

5. 在 GitHub Pages 设置中选择 GitHub Actions 作为发布来源，再推送 `main`
   分支。工作流会生成 `public/config.js` 并发布 `public/`。

## 旧数据迁移

迁移前先备份 `data/state.json`，然后执行 dry-run：

```powershell
$env:LEGACY_LOOKUP_SECRET = '<state.json 中的 secret>'
node scripts/migrate-local-state.js
```

确认数量无误后，设置 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，再执行：

```powershell
node scripts/migrate-local-state.js --apply
```

迁移会保留旧访问码的使用次数和原生成算法，旧访问码无需重新分发。

## 本地运行

安装依赖并启动本地服务：

```powershell
npm install
npm start
```

默认访问 <http://127.0.0.1:8787>。如端口被占用，可先设置 `PORT`：

```powershell
$env:PORT = '8788'
npm start
```

本地模式继续使用 `data/state.json`，不会连接 Supabase。每个访问码最多开始
3 次测试；每份结果最多邀请好友 3 次。保存和转发结果长图不占用邀请额度。

## 验证

```powershell
npm test
npm run test:e2e
node scripts/migrate-local-state.js
```

后台入口为 `/admin`。后台密码通过 Supabase Secret `ADMIN_PASSWORD` 配置；
本地后台密码由 `data/admin.json` 保存。
