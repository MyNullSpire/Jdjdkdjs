# Telegram Video Compressor — Cloudflare Workers

پروژهٔ Wrangler-ready برای ربات Telegram فشرده‌سازی ویدئو. Worker از Cloudflare Media Transformations استفاده می‌کند و برای ویدئوهای طولانی‌تر، در صورت فعال‌سازی Stream binding، مسیر Cloudflare Stream را هم دارد.

## استقرار

1. Node.js 20+ نصب باشد.
2. داخل همین پوشه اجرا کن:

```bash
npm install
npm run check
npx wrangler login
npm run deploy
```

برای فعال‌کردن Stream:

```bash
npm run deploy:stream
```

فایل `wrangler.jsonc` اتصال `MEDIA` را تعریف می‌کند. فایل `wrangler.with-stream.jsonc` علاوه بر آن `STREAM` را هم تعریف می‌کند. Cloudflare برای Media Transformations binding و Stream binding این ساختار Wrangler را مستند کرده است.

## راه‌اندازی ربات

بعد از Deploy، آدرس Worker را بردار و باز کن:

`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/setup`

این endpoint با Telegram `setWebhook` و `setMyCommands` را اجرا می‌کند. بعد ربات را در Telegram باز کن و `/start` بفرست.

## نکته مهم

Dashboard uploader برای پروژه‌هایی که نیاز به build/deploy pipeline دارند می‌تواند درخواست `wrangler deploy` بدهد؛ این بسته عمداً یک پروژهٔ کامل Wrangler است. طبق مستندات Cloudflare، Wrangler فایل پیکربندی را منبع اصلی پروژه می‌داند و `wrangler deploy` روش استاندارد استقرار است.

Media Transformations برای هر خروجی `mode=video` مدت 1 تا 60 ثانیه دارد. برای ویدئوهای طولانی، نسخهٔ اصلی کد فقط وقتی `STREAM` binding موجود باشد، پردازش کامل را به Stream می‌سپارد تا ویدئو بریده نشود.

## امنیت

طبق درخواست پروژه، Bot Token داخل `src/index.js` hard-code شده است. در استفادهٔ عمومی بهتر است بعداً Token را در Worker Secret قرار بدهی.
