# Vercel + Supabase 部署清单

## 1. Supabase

1. 打开 SQL Editor。
2. 执行 [supabase-schema.sql](/Users/tangyuandediannao/Documents/New%20project/ImageHub/docs/supabase-schema.sql) 全文。
3. 注册一个你的运营邮箱账号。
4. 再执行一次最后那行管理员 SQL，把你的邮箱设成管理员：

```sql
update public.profiles
set is_admin = true
where email = '你的邮箱';
```

## 2. Vercel 环境变量

在 Vercel 项目里添加：

```bash
VITE_SUPABASE_URL=https://atudxcosmsnehcjqwdaz.supabase.co
VITE_SUPABASE_ANON_KEY=你的 publishable key
SUPABASE_SERVICE_ROLE_KEY=你的 service_role key
VITE_USE_MANAGED_API=true
VITE_MANAGED_API_LABEL=平台托管生图服务
VITE_MANAGED_API_DESCRIPTION=API URL 与 API Key 已固定在服务端，前端用户无需填写
VITE_ALLOWED_API_ENDPOINTS=[{"value":"https://www.meitujingling.cn/","label":"主服务","description":"固定地址"}]
ALLOWED_API_BASE_URLS=https://www.meitujingling.cn/
UPSTREAM_API_BASE_URL=https://www.meitujingling.cn/
UPSTREAM_API_KEY=你的真实上游 key
PUBLIC_REFERENCE_BASE_URL=https://www.meitujingling.cn
ADMIN_USERNAME=admin
ADMIN_INITIAL_PASSWORD=你自己的后台密码
```

## 3. 仍需你自己保管的敏感项

- 上游真实 `API Key`
- `SUPABASE_SERVICE_ROLE_KEY`

这两个都不要写进前端源码，也不要提交到 GitHub。

## 4. 本地开发

项目已经支持从 `.env.local` 读取：

```bash
cd "/Users/tangyuandediannao/Documents/New project/ImageHub"
npm run dev
```

## 5. 当前这版已完成的能力

- Supabase 邮箱注册/登录接线
- 积分与价格配置的数据结构
- 前端按次扣积分的 RPC 调用入口
- 管理端价格/积分调整的 Supabase 接口入口

## 6. 上线前最后确认

- Supabase Authentication 里是否启用了 Email
- 邮箱确认策略是否符合你的首发方式
- `app_settings` 默认价格是否正确
- `app_settings` 里的上游分组、协议、模型和中转地址是否已由管理员配置好
- 你的运营账号是否已设为 `is_admin = true`
