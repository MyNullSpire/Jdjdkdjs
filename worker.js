const BOT_TOKEN = "8409047567:AAGkP03XmrNjE5sxSYDfhbY_tEMM5dXrwFc";
const WEBHOOK_SECRET = "light-kali-video-compressor-2026";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const VERSION = "4.0.0";
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_DURATION_SECONDS = 10 * 60;
const MEDIA_MAX_OUTPUT_DURATION_SECONDS = 60;
const TOKEN_TTL_SECONDS = 60 * 60;
const STREAM_JOB_TTL_DAYS = 30;
const DEFAULT_QUALITY = 360;
const QUALITIES = [144, 240, 360, 480, 720, 1080];
const COMMANDS = [
  { command: "start", description: "شروع و راهنمای ربات" },
  { command: "help", description: "راهنما" },
  { command: "all", description: "همه کیفیت‌های ممکن" },
  { command: "original", description: "فایل اصلی" },
  { command: "144", description: "144p" },
  { command: "240", description: "240p" },
  { command: "360", description: "360p" },
  { command: "480", description: "480p" },
  { command: "720", description: "720p" },
  { command: "1080", description: "1080p" },
  { command: "qualities", description: "کیفیت‌های قابل دریافت" },
  { command: "status", description: "وضعیت پردازش Cloudflare Stream" },
  { command: "ping", description: "بررسی وضعیت ربات" }
];

let signingKeyPromise;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const method = request.method.toUpperCase();

    if (path === "/" && method === "GET") return serviceInfo(url, env);
    if (path === "/health" && (method === "GET" || method === "HEAD")) return health(url, env, method);
    if (path === "/setup" && (method === "GET" || method === "POST")) return setup(url, env);
    if (path === "/diagnostics" && (method === "GET" || method === "POST")) return diagnostics(url, env);
    if (path.startsWith("/source/") && (method === "GET" || method === "HEAD")) return sourceProxy(request, path.slice(8));
    if (path.startsWith("/transform/") && (method === "GET" || method === "HEAD")) return transformEndpoint(request, path.slice(11), url, env);
    if (path === "/telegram" && method === "POST") return telegramWebhook(request, url, env, ctx);
    return textResponse("Not Found", 404);
  }
};

function normalizePath(path) {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function serviceInfo(url, env) {
  const workerDev = url.hostname.endsWith(".workers.dev");
  return json({
    ok: true,
    service: "Telegram Video Compressor",
    version: VERSION,
    webhook: `${url.origin}/telegram`,
    setup: `${url.origin}/setup`,
    health: `${url.origin}/health`,
    diagnostics: `${url.origin}/diagnostics`,
    engines: {
      media_transformations_url: true,
      media_transformations_binding: Boolean(env?.MEDIA),
      stream_full_duration_fallback: Boolean(env?.STREAM)
    },
    limitations: {
      telegram_download_mb: 20,
      telegram_upload_mb: 50,
      telegram_webhook_https: true,
      input_duration_minutes: 10,
      media_transformations_output_seconds: MEDIA_MAX_OUTPUT_DURATION_SECONDS
    },
    qualities: QUALITIES,
    default_quality: DEFAULT_QUALITY,
    worker_dev_warning: workerDev ? "For URL Media Transformations, use a custom Cloudflare zone/domain with Transformations enabled. Stream binding can work on the Worker endpoint when configured." : null
  });
}

function health(url, env, method) {
  return methodHeadAware({
    ok: true,
    service: "Telegram Video Compressor",
    version: VERSION,
    now: new Date().toISOString(),
    origin: url.origin,
    worker_dev: url.hostname.endsWith(".workers.dev"),
    media_binding: Boolean(env?.MEDIA),
    stream_binding: Boolean(env?.STREAM),
    url_transformations: `${url.origin}/cdn-cgi/media/mode=video,height=360,fit=scale-down,audio=true,duration=60s/https://example.com/video.mp4`,
    notes: [
      "Media Transformations video output is limited to 60 seconds per request.",
      "Full-duration fallback uses Cloudflare Stream when STREAM binding is configured."
    ]
  }, method === "HEAD");
}

async function diagnostics(url, env) {
  const [me, webhook] = await Promise.all([
    telegramCall("getMe"),
    telegramCall("getWebhookInfo")
  ]);
  let stream = null;
  if (env?.STREAM) {
    try {
      const videos = await env.STREAM.videos.list({ limit: 1 });
      stream = { ok: true, sample_count: Array.isArray(videos) ? videos.length : null };
    } catch (error) {
      stream = { ok: false, error: errorMessage(error) };
    }
  }
  return json({
    ok: Boolean(me.ok && webhook.ok),
    service: "Telegram Video Compressor",
    version: VERSION,
    worker: {
      origin: url.origin,
      worker_dev: url.hostname.endsWith(".workers.dev")
    },
    telegram: { getMe: redactTelegramMe(me), getWebhookInfo: webhook },
    cloudflare: {
      media_transformations_binding: Boolean(env?.MEDIA),
      stream_binding: Boolean(env?.STREAM),
      stream_check: stream,
      url_transformations_ready: !url.hostname.endsWith(".workers.dev")
    },
    limitations: {
      telegram_getfile_max_bytes: MAX_INPUT_BYTES,
      telegram_upload_max_bytes: MAX_TELEGRAM_UPLOAD_BYTES,
      media_transformations_input_max_bytes: 100 * 1024 * 1024,
      media_transformations_input_max_duration_seconds: MAX_INPUT_DURATION_SECONDS,
      media_transformations_output_max_duration_seconds: MEDIA_MAX_OUTPUT_DURATION_SECONDS
    }
  });
}

async function setup(url, env) {
  if (url.protocol !== "https:") return json({ ok: false, error: "Webhook must use HTTPS." }, 400);
  const dropPending = url.searchParams.get("drop") === "1" || url.searchParams.get("drop") === "true";
  const webhookUrl = `${url.origin}/telegram`;
  const setWebhook = await telegramCall("setWebhook", {
    url: webhookUrl,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    max_connections: 40,
    drop_pending_updates: dropPending
  });
  const commands = await telegramCall("setMyCommands", { commands: COMMANDS });
  const me = await telegramCall("getMe");
  const webhook = await telegramCall("getWebhookInfo");
  const configured = Boolean(setWebhook.ok && commands.ok && me.ok);
  return json({
    ok: configured,
    version: VERSION,
    configured_webhook: webhookUrl,
    setup_mode: "public-fast-setup",
    drop_pending_updates: dropPending,
    telegram: {
      setWebhook,
      setMyCommands: commands,
      getMe: redactTelegramMe(me),
      getWebhookInfo: webhook
    },
    cloudflare: {
      media_binding: Boolean(env?.MEDIA),
      stream_binding: Boolean(env?.STREAM),
      worker_dev: url.hostname.endsWith(".workers.dev"),
      warning: url.hostname.endsWith(".workers.dev") && !env?.MEDIA
        ? "URL Media Transformations require a Cloudflare zone/domain with Transformations enabled; bind MEDIA for Worker-side transformations or use a custom domain."
        : null
    }
  }, configured ? 200 : 502);
}

async function telegramWebhook(request, url, env, ctx) {
  const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!constantTimeEqualString(incomingSecret || "", WEBHOOK_SECRET)) return textResponse("Forbidden", 403);

  let update;
  try {
    update = await request.json();
  } catch {
    return textResponse("Bad Request", 400);
  }

  if (!update || typeof update !== "object") return textResponse("OK", 200);

  try {
    if (update.callback_query) return await handleCallbackQuery(update.callback_query, url, env, ctx);
    if (update.message) return await handleMessage(update.message, url, env, ctx);
    return textResponse("OK", 200);
  } catch (error) {
    console.error("Webhook error", error);
    const chatId = getChatId(update);
    if (chatId == null) return textResponse("OK", 200);
    return json(sendMessageMethod(chatId, `خطا در پردازش: ${safeUserError(error)}`));
  }
}

async function handleMessage(message, url, env, ctx) {
  const chatId = message.chat?.id;
  if (chatId == null) return textResponse("OK", 200);

  const command = parseCommand(message.text);
  if (command) return handleCommand(message, command, url, env, ctx);

  const media = extractVideo(message);
  if (!media) {
    return json(sendMessageMethod(chatId, [
      "ویدئو را همین‌جا بفرست یا Forward کن.",
      "برای ویدئوهای کوتاه، کیفیت‌های 144p تا 1080p بر اساس رزولوشن اصلی در دسترس هستند.",
      "برای ویدئوهای طولانی‌تر، در صورت فعال بودن Cloudflare Stream، یک خروجی کاملِ بهینه‌شده ساخته می‌شود.",
      "دستورها: /144 /240 /360 /480 /720 /1080 /all /original"
    ].join("\n")));
  }

  const preflight = validateMedia(media);
  if (!preflight.ok) return json(sendMessageMethod(chatId, preflight.message));

  const fileInfo = await telegramCall("getFile", { file_id: media.fileId });
  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    return json(sendMessageMethod(chatId, "Telegram نتوانست فایل را آماده کند. دوباره ارسالش کن."));
  }

  const realSize = Number(fileInfo.result.file_size || media.fileSize || 0);
  if (realSize > MAX_INPUT_BYTES) {
    return json(sendMessageMethod(chatId, "این فایل بزرگ‌تر از سقف 20MB دریافت Bot API است."));
  }

  const token = await createSignedToken({
    p: fileInfo.result.file_path,
    n: media.fileName || "video.mp4",
    d: Number(media.duration || 0),
    w: Number(media.width || 0),
    h: Number(media.height || 0)
  });
  const sourceUrl = `${url.origin}/source/${token}`;

  if (Number(media.duration || 0) > MEDIA_MAX_OUTPUT_DURATION_SECONDS) {
    if (env?.STREAM) return startStreamFallback(message, media, sourceUrl, env);
    return json(sendMessageMethod(chatId, "این ویدئو بیشتر از 60 ثانیه است. Cloudflare Media Transformations برای هر خروجی ویدئویی حداکثر 60 ثانیه می‌دهد و من عمداً ویدئو را ناقص ارسال نمی‌کنم. برای پردازش کامل، binding به نام STREAM را در Worker فعال کن."));
  }

  if (!media.durationKnown) {
    if (env?.STREAM) return startStreamFallback(message, media, sourceUrl, env);
    return json(sendMessageMethod(chatId, "این فایل به‌صورت Document فرستاده شده و Telegram اطلاعات مدت/رزولوشن را در اختیار ربات نگذاشته است. برای تبدیل دقیق، آن را به‌صورت Video بفرست یا STREAM را فعال کن."));
  }
  const available = getAvailableQualities(media.height);
  if (!available.length) return json(sendMessageMethod(chatId, "رزولوشن ویدئو قابل تشخیص نیست."));
  const initialQuality = chooseInitialQuality(available, media.duration);
  const caption = buildCaption(media.fileName, initialQuality, media.width, media.height);
  const keyboard = buildQualityKeyboard(available, true);
  const duration = Math.max(1, Math.min(MEDIA_MAX_OUTPUT_DURATION_SECONDS, Number(media.duration || 60)));
  const attempts = buildFallbackOrder(initialQuality, available);
  for (const quality of attempts) {
    const result = await telegramCall("sendVideo", {
      chat_id: chatId,
      video: buildTransformRequestUrl(url.origin, token, quality),
      caption: quality === initialQuality ? caption : buildCaption(media.fileName, quality, media.width, media.height),
      supports_streaming: true,
      reply_markup: keyboard,
      ...(buildReplyFields(message))
    }, { retries: 0 });
    if (result.ok) return textResponse("OK", 200);
  }
  const original = await uploadOriginalFallback(chatId, media, sourceUrl, message);
  if (original.ok) return textResponse("OK", 200);
  return json(sendMessageMethod(chatId, "هیچ خروجی فشرده‌ای آماده نشد و fallback فایل اصلی هم ناموفق بود."));
}

async function handleCommand(message, command, url, env, ctx) {
  const chatId = message.chat?.id;
  if (chatId == null) return textResponse("OK", 200);

  if (command === "start" || command === "help") {
    return json(sendMessageMethod(chatId, [
      "ربات فشرده‌سازی و تبدیل ویدئو",
      "",
      "یک ویدئو بفرست یا Forward کن.",
      "برای ویدئوهای حداکثر 60 ثانیه، دکمه‌های کیفیت فعال می‌شوند.",
      "برای ویدئوهای طولانی، در صورت وجود binding به نام STREAM، خروجی کاملِ بهینه‌شده پردازش می‌شود.",
      "",
      "/144 /240 /360 /480 /720 /1080 /all /original /status"
    ].join("\n")));
  }

  if (command === "ping") return json(sendMessageMethod(chatId, "OK — ربات آنلاین است."));

  if (command === "status") {
    const uid = extractStreamIdFromMessage(message);
    if (!uid) return json(sendMessageMethod(chatId, "این دستور را Reply روی پیام پردازش Stream بفرست."));
    return handleStreamStatus(message, uid, env);
  }

  const replyMedia = findReplyVideo(message);
  if (!replyMedia) return json(sendMessageMethod(chatId, "برای انتخاب کیفیت، دستور را Reply روی پیام ویدئو بفرست."));

  if (command === "all") return handleAllQualityRequest(message, replyMedia, url, env);
  if (command === "original") return handleOriginalRequest(message, replyMedia, url);

  if (command === "qualities") {
    const available = getAvailableQualities(replyMedia.height);
    return json(sendMessageMethod(chatId, `کیفیت‌های قابل‌دریافت: ${available.map(q => `${q}p`).join("، ") || "نامشخص"}`));
  }

  const requested = Number(command);
  if (!QUALITIES.includes(requested)) return json(sendMessageMethod(chatId, "کیفیت نامعتبر است."));
  return handleSingleQualityRequest(message, replyMedia, requested, url, env);
}

async function handleCallbackQuery(query, url, env, ctx) {
  const callbackId = query.id;
  const data = String(query.data || "");
  const message = query.message;
  const chatId = message?.chat?.id;

  if (callbackId) {
    await telegramCall("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: data.startsWith("s:") ? "در حال بررسی وضعیت…" : "در حال آماده‌سازی…",
      show_alert: false
    }, { retries: 1 });
  }
  if (chatId == null || !message) return textResponse("OK", 200);

  if (data.startsWith("s:")) return handleStreamStatus(message, data.slice(2), env);
  if (data.startsWith("d:")) return handleStreamDownload(message, data.slice(2), env);

  const replyMedia = message.reply_to_message ? extractVideo(message.reply_to_message) : null;
  if (!replyMedia) return json(sendMessageMethod(chatId, "پیام اصلی ویدئو دیگر در دسترس نیست. ویدئو را دوباره بفرست."));

  if (data === "all") return handleAllQualityRequest(message, replyMedia, url, env);
  if (data === "original") return handleOriginalRequest(message, replyMedia, url);

  const requested = Number(data.replace(/^q:/, ""));
  if (!QUALITIES.includes(requested)) return json(sendMessageMethod(chatId, "درخواست کیفیت نامعتبر است."));
  return handleSingleQualityRequest(message, replyMedia, requested, url, env);
}

async function handleSingleQualityRequest(message, media, requestedQuality, url, env) {
  const chatId = message.chat?.id;
  if (!media.durationKnown || Number(media.duration || 0) > MEDIA_MAX_OUTPUT_DURATION_SECONDS) {
    if (env?.STREAM) {
      const token = await getFreshSourceToken(media);
      return startStreamFallback(message, media, `${url.origin}/source/${token}`, env);
    }
    return json(sendMessageMethod(chatId, "این ویدئو بیشتر از 60 ثانیه است؛ برای پردازش کامل STREAM را فعال کن."));
  }

  const fileInfo = await telegramCall("getFile", { file_id: media.fileId });
  if (!fileInfo.ok || !fileInfo.result?.file_path) return json(sendMessageMethod(chatId, "Telegram نتوانست فایل اصلی را آماده کند."));
  const realSize = Number(fileInfo.result.file_size || media.fileSize || 0);
  if (realSize > MAX_INPUT_BYTES) return json(sendMessageMethod(chatId, "حجم فایل از 20MB بیشتر است."));

  const available = getAvailableQualities(media.height);
  const target = nearestAvailableQuality(requestedQuality, available);
  if (!target) return json(sendMessageMethod(chatId, "کیفیت مناسبی برای این ویدئو وجود ندارد."));

  const token = await createSignedToken({
    p: fileInfo.result.file_path,
    n: media.fileName || "video.mp4",
    d: Number(media.duration || 0),
    w: Number(media.width || 0),
    h: Number(media.height || 0)
  });
  const sourceUrl = `${url.origin}/source/${token}`;
  const duration = Math.max(1, Math.min(MEDIA_MAX_OUTPUT_DURATION_SECONDS, Number(media.duration || 60)));
  const attempts = buildFallbackOrder(target, available);
  const result = await trySendQuality(chatId, media, url.origin, token, attempts, message);
  if (result.ok) return textResponse("OK", 200);
  const original = await uploadOriginalFallback(chatId, media, sourceUrl, message);
  if (original.ok) return textResponse("OK", 200);
  return json(sendMessageMethod(chatId, "تبدیل و fallback فایل ناموفق بود. دوباره تلاش کن."));
}

async function handleAllQualityRequest(message, media, url, env) {
  const chatId = message.chat?.id;
  if (!media.durationKnown || Number(media.duration || 0) > MEDIA_MAX_OUTPUT_DURATION_SECONDS) {
    if (env?.STREAM) {
      const token = await getFreshSourceToken(media);
      return startStreamFallback(message, media, `${url.origin}/source/${token}`, env);
    }
    return json(sendMessageMethod(chatId, "برای ویدئوهای بیشتر از 60 ثانیه، /all به‌صورت خروجی کامل نیاز به STREAM دارد."));
  }

  const fileInfo = await telegramCall("getFile", { file_id: media.fileId });
  if (!fileInfo.ok || !fileInfo.result?.file_path) return json(sendMessageMethod(chatId, "Telegram نتوانست فایل را آماده کند."));
  const realSize = Number(fileInfo.result.file_size || media.fileSize || 0);
  if (realSize > MAX_INPUT_BYTES) return json(sendMessageMethod(chatId, "حجم فایل از 20MB بیشتر است."));

  const available = getAvailableQualities(media.height);
  if (!available.length) return json(sendMessageMethod(chatId, "رزولوشن ویدئو قابل تشخیص نیست."));
  const token = await createSignedToken({
    p: fileInfo.result.file_path,
    n: media.fileName || "video.mp4",
    d: Number(media.duration || 0),
    w: Number(media.width || 0),
    h: Number(media.height || 0)
  });
  const sourceUrl = `${url.origin}/source/${token}`;
  const duration = Math.max(1, Math.min(MEDIA_MAX_OUTPUT_DURATION_SECONDS, Number(media.duration || 60)));
  const items = available.map(quality => ({
    type: "video",
    media: buildTransformRequestUrl(url.origin, token, quality),
    caption: buildCaption(media.fileName, quality, media.width, media.height),
    supports_streaming: true
  }));

  if (items.length === 1) {
    const result = await telegramCall("sendVideo", {
      chat_id: chatId,
      video: items[0].media,
      caption: items[0].caption,
      supports_streaming: true,
      ...(buildReplyFields(message))
    }, { retries: 0 });
    if (result.ok) return textResponse("OK", 200);
  } else {
    const group = await telegramCall("sendMediaGroup", {
      chat_id: chatId,
      media: items,
      ...(buildReplyFields(message))
    }, { retries: 0 });
    if (group.ok) return textResponse("OK", 200);
  }

  for (const quality of [...available].sort((a, b) => b - a)) {
    const result = await telegramCall("sendVideo", {
      chat_id: chatId,
      video: buildTransformRequestUrl(url.origin, token, quality),
      caption: buildCaption(media.fileName, quality, media.width, media.height),
      supports_streaming: true,
      ...(buildReplyFields(message))
    }, { retries: 0 });
    if (!result.ok) continue;
  }
  return textResponse("OK", 200);
}

async function handleOriginalRequest(message, media, url) {
  const chatId = message.chat?.id;
  const fileInfo = await telegramCall("getFile", { file_id: media.fileId });
  if (!fileInfo.ok || !fileInfo.result?.file_path) return json(sendMessageMethod(chatId, "Telegram نتوانست فایل اصلی را آماده کند."));
  const realSize = Number(fileInfo.result.file_size || media.fileSize || 0);
  if (realSize > MAX_INPUT_BYTES) return json(sendMessageMethod(chatId, "حجم فایل اصلی بیشتر از 20MB است."));
  const token = await createSignedToken({ p: fileInfo.result.file_path, n: media.fileName || "video.mp4", d: Number(media.duration || 0), w: Number(media.width || 0), h: Number(media.height || 0) });
  const sourceUrl = `${url.origin}/source/${token}`;
  const uploaded = await uploadOriginalFallback(chatId, media, sourceUrl, message);
  return uploaded.ok ? textResponse("OK", 200) : json(sendMessageMethod(chatId, "ارسال فایل اصلی ناموفق بود."));
}

async function trySendQuality(chatId, media, origin, token, attempts, message) {
  let last = null;
  for (const quality of attempts) {
    const response = await telegramCall("sendVideo", {
      chat_id: chatId,
      video: buildTransformRequestUrl(origin, token, quality),
      caption: buildCaption(media.fileName, quality, media.width, media.height),
      supports_streaming: true,
      ...(buildReplyFields(message))
    }, { retries: 0 });
    if (response.ok) return { ...response, quality };
    last = response;
  }
  return last || { ok: false };
}

async function uploadOriginalFallback(chatId, media, sourceUrl, message) {
  try {
    const source = await fetch(sourceUrl, { headers: { Range: "bytes=0-" } });
    if (!source.ok || !source.body) return { ok: false, description: `Source HTTP ${source.status}` };
    const length = Number(source.headers.get("Content-Length") || 0);
    if (length > MAX_TELEGRAM_UPLOAD_BYTES) return { ok: false, description: "File is over Telegram upload limit" };
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength > MAX_TELEGRAM_UPLOAD_BYTES) return { ok: false, description: "File is over Telegram upload limit" };
    const name = sanitizeUploadName(media.fileName || "video.mp4");
    const type = source.headers.get("Content-Type") || "video/mp4";
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.append("video", new Blob([bytes], { type }), name);
    form.set("caption", `${name}\nنسخه اصلی`);
    appendReplyFormFields(form, message);
    return telegramUpload("sendVideo", form, { retries: 1 });
  } catch (error) {
    return { ok: false, description: errorMessage(error) };
  }
}

async function startStreamFallback(message, media, sourceUrl, env) {
  const chatId = message.chat?.id;
  if (!env?.STREAM) return json(sendMessageMethod(chatId, "STREAM فعال نیست."));
  try {
    const deletion = new Date(Date.now() + STREAM_JOB_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const video = await env.STREAM.upload(sourceUrl, {
      creator: String(message.from?.id || chatId || "telegram"),
      meta: {
        chat_id: String(chatId),
        message_id: String(message.message_id || ""),
        name: sanitizeMeta(media.fileName || "video.mp4")
      },
      scheduledDeletion: deletion
    });
    const uid = String(video?.uid || video?.id || "");
    if (!uid) return json(sendMessageMethod(chatId, "Cloudflare Stream شناسه پردازش را برنگرداند."));
    const caption = [
      "ویدئوی طولانی دریافت شد.",
      "Cloudflare Stream در حال پردازش خروجی کامل است.",
      `Stream ID: ${uid}`,
      "پس از آماده شدن، دکمه بررسی وضعیت را بزن."
    ].join("\n");
    return json({
      method: "sendMessage",
      chat_id: chatId,
      text: caption,
      ...(buildReplyFields(message)),
      reply_markup: {
        inline_keyboard: [[{ text: "بررسی وضعیت", callback_data: `s:${uid}` }]]
      }
    });
  } catch (error) {
    console.error("Stream upload error", error);
    return json(sendMessageMethod(chatId, `پردازش کامل با Stream شروع نشد: ${safeUserError(error)}`));
  }
}

async function handleStreamStatus(message, uid, env) {
  const chatId = message.chat?.id;
  if (!env?.STREAM) return json(sendMessageMethod(chatId, "STREAM روی این Worker فعال نیست."));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return json(sendMessageMethod(chatId, "شناسه Stream نامعتبر است."));
  try {
    const video = env.STREAM.video(uid);
    const details = await video.details();
    const state = String(details?.status?.state || "unknown");
    const pct = Number(details?.status?.pctComplete ?? details?.status?.percentComplete ?? 0);
    if (state === "error") {
      return json(sendMessageMethod(chatId, `پردازش Stream با خطا متوقف شد: ${details?.status?.errReasonText || details?.status?.errorReasonText || "خطای نامشخص"}`));
    }
    if (state !== "ready" || details?.readyToStream !== true) {
      return json({
        method: "sendMessage",
        chat_id: chatId,
        text: `هنوز آماده نیست. وضعیت: ${state} — ${Number.isFinite(pct) ? Math.round(pct) : 0}%`,
        ...(buildReplyFields(message)),
        reply_markup: { inline_keyboard: [[{ text: "بررسی دوباره", callback_data: `s:${uid}` }]] }
      });
    }

    let downloads = await video.downloads.get();
    let download = downloads?.default;
    if (!download) {
      downloads = await video.downloads.generate("default");
      download = downloads?.default || downloads?.result?.default;
    }
    const url = String(download?.url || "");
    const status = String(download?.status || "");
    if (status !== "ready" || !url) {
      return json({
        method: "sendMessage",
        chat_id: chatId,
        text: `ویدئو آماده شده؛ فایل MP4 در حال آماده‌سازی است: ${Number(download?.percentComplete || 0).toFixed(0)}%`,
        ...(buildReplyFields(message)),
        reply_markup: { inline_keyboard: [[{ text: "بررسی دانلود", callback_data: `d:${uid}` }]] }
      });
    }

    return json({
      method: "sendMessage",
      chat_id: chatId,
      text: "نسخه کامل آماده است.",
      ...(buildReplyFields(message)),
      reply_markup: {
        inline_keyboard: [[{ text: "ارسال ویدئو به تلگرام", callback_data: `d:${uid}` }], [{ text: "لینک MP4", url }]]
      }
    });
  } catch (error) {
    console.error("Stream status error", error);
    return json(sendMessageMethod(chatId, `خطا در بررسی Stream: ${safeUserError(error)}`));
  }
}

async function handleStreamDownload(message, uid, env) {
  const chatId = message.chat?.id;
  if (!env?.STREAM) return json(sendMessageMethod(chatId, "STREAM فعال نیست."));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return json(sendMessageMethod(chatId, "شناسه Stream نامعتبر است."));
  try {
    const video = env.STREAM.video(uid);
    const downloads = await video.downloads.get();
    let download = downloads?.default;
    if (!download || download.status !== "ready" || !download.url) {
      if (!download) {
        const generated = await video.downloads.generate("default");
        download = generated?.default || generated?.result?.default;
      }
      if (!download?.url || download?.status !== "ready") {
        return json({
          method: "sendMessage",
          chat_id: chatId,
          text: `هنوز فایل MP4 آماده نیست: ${Number(download?.percentComplete || 0).toFixed(0)}%`,
          ...(buildReplyFields(message)),
          reply_markup: { inline_keyboard: [[{ text: "دوباره بررسی کن", callback_data: `d:${uid}` }]] }
        });
      }
    }

    const downloadUrl = String(download.url);
    const head = await fetch(downloadUrl, { method: "HEAD" });
    const size = Number(head.headers.get("Content-Length") || 0);
    if (size > 0 && size <= MAX_TELEGRAM_UPLOAD_BYTES) {
      if (size <= MAX_INPUT_BYTES) {
        return json({
          method: "sendVideo",
          chat_id: chatId,
          video: downloadUrl,
          caption: "نسخه کاملِ بهینه‌شده با Cloudflare Stream",
          supports_streaming: true,
          ...(buildReplyFields(message))
        });
      }
      const uploaded = await uploadExternalVideo(chatId, downloadUrl, message, size);
      if (uploaded.ok) return textResponse("OK", 200);
    }

    if (size === 0) {
      const uploaded = await uploadExternalVideo(chatId, downloadUrl, message, 0);
      if (uploaded.ok) return textResponse("OK", 200);
    }

    return json({
      method: "sendMessage",
      chat_id: chatId,
      text: "فایل آماده است، اما اندازه آن از سقف ارسال مستقیم ربات بیشتر است. لینک MP4:",
      ...(buildReplyFields(message)),
      reply_markup: { inline_keyboard: [[{ text: "باز کردن MP4", url: downloadUrl }]] }
    });
  } catch (error) {
    console.error("Stream download error", error);
    return json(sendMessageMethod(chatId, `ارسال خروجی Stream ناموفق شد: ${safeUserError(error)}`));
  }
}

async function uploadExternalVideo(chatId, downloadUrl, message, knownSize) {
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok || !response.body) return { ok: false, description: `HTTP ${response.status}` };
    const length = Number(response.headers.get("Content-Length") || knownSize || 0);
    if (length > MAX_TELEGRAM_UPLOAD_BYTES) return { ok: false, description: "Over 50MB" };
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_TELEGRAM_UPLOAD_BYTES) return { ok: false, description: "Over 50MB" };
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.append("video", new Blob([bytes], { type: "video/mp4" }), "compressed.mp4");
    form.set("caption", "نسخه کاملِ بهینه‌شده با Cloudflare Stream");
    appendReplyFormFields(form, message);
    return telegramUpload("sendVideo", form, { retries: 1 });
  } catch (error) {
    return { ok: false, description: errorMessage(error) };
  }
}

async function transformEndpoint(request, token, url, env) {
  const verified = await verifySignedToken(token);
  if (!verified.ok) return textResponse("Invalid or expired source token", 403);
  const quality = Number(new URL(request.url).searchParams.get("q") || DEFAULT_QUALITY);
  if (!QUALITIES.includes(quality)) return textResponse("Invalid quality", 400);
  const duration = Math.max(1, Math.min(MEDIA_MAX_OUTPUT_DURATION_SECONDS, Number(verified.duration || 60)));

  if (env?.MEDIA && typeof env.MEDIA.input === "function") {
    try {
      const source = await fetch(`${TELEGRAM_FILE_API}/${verified.filePath}`, {
        headers: request.headers.get("Range") ? { Range: request.headers.get("Range") } : {}
      });
      if (!source.ok || !source.body) return textResponse(`Source HTTP ${source.status}`, 502);
      const transformed = env.MEDIA.input(source.body)
        .transform({ height: quality, fit: "scale-down" })
        .output({ mode: "video", duration: `${duration}s`, audio: true });
      const response = await transformed.response();
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=3600");
      headers.set("Content-Type", "video/mp4");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      console.error("Media binding transform failed", error);
      return textResponse(`Media binding transform failed: ${safeUserError(error)}`, 502);
    }
  }

  const sourceUrl = `${url.origin}/source/${token}`;
  const transformOrigin = getTransformOrigin(url, env);
  if (transformOrigin.endsWith(".workers.dev")) {
    return textResponse("URL Media Transformations require a Cloudflare zone/domain with Transformations enabled. Configure a custom domain or bind MEDIA.", 503);
  }
  return Response.redirect(buildTransformUrl(transformOrigin, sourceUrl, quality, duration), 302);
}

async function sourceProxy(request, token) {
  const verified = await verifySignedToken(token);
  if (!verified.ok) return textResponse("Invalid or expired source token", 403);
  const telegramUrl = `${TELEGRAM_FILE_API}/${verified.filePath}`;
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  const ifRange = request.headers.get("If-Range");
  if (ifRange) headers.set("If-Range", ifRange);

  let response;
  try {
    response = request.method === "HEAD"
      ? await fetch(telegramUrl, { method: "HEAD", headers })
      : await fetch(telegramUrl, { method: "GET", headers });
    if (request.method === "HEAD" && (!response.ok || !response.headers.get("Content-Range"))) {
      response = await fetch(telegramUrl, { method: "GET", headers: new Headers({ Range: "bytes=0-0" }) });
      try { await response.body?.cancel(); } catch {}
    }
  } catch (error) {
    return textResponse(`Telegram source error: ${safeUserError(error)}`, 502);
  }
  return buildSourceResponse(response, request.method === "HEAD");
}

function buildSourceResponse(response, headOnly) {
  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", "video/mp4");
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  return new Response(headOnly ? null : response.body, { status: response.status, headers });
}

async function createSignedToken(meta) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = base64UrlEncodeText(JSON.stringify({ p: meta.p, n: meta.n || "video.mp4", d: Number(meta.d || 0), w: Number(meta.w || 0), h: Number(meta.h || 0), e: exp }));
  const signature = await sign(payload);
  return `${payload}.${signature}`;
}

async function verifySignedToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return { ok: false };
  const [payload, signature] = parts;
  const expected = await sign(payload);
  if (!constantTimeEqualString(signature, expected)) return { ok: false };
  try {
    const data = JSON.parse(base64UrlDecodeText(payload));
    const now = Math.floor(Date.now() / 1000);
    const exp = Number(data?.e || 0);
    const filePath = String(data?.p || "");
    if (!filePath || exp <= now || exp > now + TOKEN_TTL_SECONDS + 60) return { ok: false };
    if (filePath.includes("..") || filePath.includes("\\") || filePath.startsWith("/")) return { ok: false };
    return { ok: true, filePath, duration: Number(data?.d || 0), fileName: String(data?.n || "video.mp4"), width: Number(data?.w || 0), height: Number(data?.h || 0) };
  } catch {
    return { ok: false };
  }
}

async function sign(value) {
  if (!signingKeyPromise) {
    signingKeyPromise = crypto.subtle.importKey("raw", new TextEncoder().encode(BOT_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const key = await signingKeyPromise;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function buildTransformUrl(origin, sourceUrl, height, duration = 60) {
  const options = [
    "mode=video",
    `height=${height}`,
    "fit=scale-down",
    "audio=true",
    `duration=${Math.max(1, Math.min(MEDIA_MAX_OUTPUT_DURATION_SECONDS, Math.floor(duration)))}s`,
    `filename=telegram-video-${height}p.mp4`
  ].join(",");
  return `${origin}/cdn-cgi/media/${options}/${sourceUrl}`;
}


function buildTransformRequestUrl(origin, token, quality) {
  return `${origin}/transform/${encodeURIComponent(token)}?q=${quality}`;
}

function getTransformOrigin(url, env) {
  const configured = String(env?.TRANSFORM_ORIGIN || "").trim();
  if (!configured) return url.origin;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") return url.origin;
    return parsed.origin;
  } catch {
    return url.origin;
  }
}

async function getFreshSourceToken(media) {
  const info = await telegramCall("getFile", { file_id: media.fileId });
  if (!info.ok || !info.result?.file_path) throw new Error("Telegram file path unavailable");
  return createSignedToken({ p: info.result.file_path, n: media.fileName || "video.mp4", d: Number(media.duration || 0), w: Number(media.width || 0), h: Number(media.height || 0) });
}

function buildQualityKeyboard(available, includeAll) {
  const rows = [];
  for (let i = 0; i < available.length; i += 3) rows.push(available.slice(i, i + 3).map(q => ({ text: `${q}p`, callback_data: `q:${q}` })));
  if (includeAll && available.length > 1) rows.push([{ text: "ارسال همه کیفیت‌ها", callback_data: "all" }]);
  rows.push([{ text: "فایل اصلی", callback_data: "original" }]);
  return { inline_keyboard: rows };
}

function buildCaption(fileName, quality, width, height) {
  const source = width && height ? `\nاصلی: ${width}×${height}` : "";
  return `نسخه فشرده‌شده\nکیفیت: ${quality}p${source}\nفایل: ${sanitizeFileName(fileName || "video")}`;
}

function sendVideoMethod(chatId, video, caption, message) {
  return {
    method: "sendVideo",
    chat_id: chatId,
    video,
    caption,
    supports_streaming: true,
    ...(buildReplyFields(message))
  };
}

function sendMessageMethod(chatId, text) {
  return { method: "sendMessage", chat_id: chatId, text, disable_web_page_preview: true };
}

function buildReplyFields(message) {
  const output = {};
  const replyId = message?.message_id;
  if (replyId) output.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
  if (message?.message_thread_id) output.message_thread_id = message.message_thread_id;
  return output;
}

function appendReplyFormFields(form, message) {
  const reply = buildReplyFields(message);
  if (reply.reply_parameters) form.set("reply_parameters", JSON.stringify(reply.reply_parameters));
  if (reply.message_thread_id) form.set("message_thread_id", String(reply.message_thread_id));
}

function parseCommand(text) {
  const match = String(text || "").trim().match(/^\/(start|help|all|original|qualities|status|ping|144|240|360|480|720|1080)(?:@[^\s]+)?(?:\s.*)?$/i);
  return match ? match[1].toLowerCase() : null;
}

function extractStreamIdFromMessage(message) {
  const text = String(message?.reply_to_message?.text || "");
  const match = text.match(/Stream\s*ID\s*:\s*([A-Za-z0-9_-]+)/i);
  return match?.[1] || null;
}

function extractVideo(message) {
  if (!message || typeof message !== "object") return null;
  if (message.video) {
    return {
      type: "video",
      fileId: message.video.file_id,
      fileSize: Number(message.video.file_size || 0),
      duration: Number(message.video.duration || 0),
      durationKnown: true,
      width: Number(message.video.width || 0),
      height: Number(message.video.height || 0),
      fileName: message.video.file_name || "video.mp4"
    };
  }
  if (message.document && /^video\//i.test(String(message.document.mime_type || ""))) {
    return {
      type: "document",
      fileId: message.document.file_id,
      fileSize: Number(message.document.file_size || 0),
      duration: Number(message.document.duration || 0),
      durationKnown: Boolean(message.document.duration),
      width: Number(message.document.width || 0),
      height: Number(message.document.height || 0),
      fileName: message.document.file_name || "video.mp4"
    };
  }
  return null;
}

function findReplyVideo(message) {
  return message?.reply_to_message ? extractVideo(message.reply_to_message) : null;
}

function getChatId(update) {
  return update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? null;
}

function validateMedia(media) {
  if (!media?.fileId) return { ok: false, message: "فایل ویدئو معتبر نیست." };
  if (Number(media.fileSize || 0) > MAX_INPUT_BYTES) return { ok: false, message: "حجم ویدئو بیشتر از 20MB است." };
  if (Number(media.duration || 0) > MAX_INPUT_DURATION_SECONDS) return { ok: false, message: "مدت ویدئو بیشتر از 10 دقیقه است." };
  return { ok: true };
}

function getAvailableQualities(sourceHeight) {
  const h = Number(sourceHeight || 0);
  if (h <= 0) return [...QUALITIES];
  return QUALITIES.filter(q => q <= h);
}

function chooseInitialQuality(available, duration = 0) {
  if (!available.length) return DEFAULT_QUALITY;
  const preferred = Number(duration || 0) > 30 ? 240 : DEFAULT_QUALITY;
  return available.includes(preferred) ? preferred : available[available.length - 1];
}

function nearestAvailableQuality(requested, available) {
  if (!available.length) return null;
  if (available.includes(requested)) return requested;
  const lower = available.filter(q => q <= requested);
  return lower.length ? lower[lower.length - 1] : available[0];
}

function buildFallbackOrder(target, available) {
  return [...new Set(available.filter(q => q <= target).sort((a, b) => b - a))];
}

function sanitizeFileName(name) {
  return String(name).replace(/[\r\n]/g, " ").slice(0, 80);
}

function sanitizeUploadName(name) {
  const value = String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return value || "video.mp4";
}

function sanitizeMeta(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

async function telegramUpload(method, form, options = {}) {
  const retries = Number(options.retries ?? 1);
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await fetch(`${TELEGRAM_API}/${method}`, { method: "POST", body: form });
      let data;
      try { data = await response.json(); } catch { data = { ok: false, description: `Telegram HTTP ${response.status}` }; }
      if (data?.ok) return data;
      const retryAfter = Number(data?.parameters?.retry_after || 0);
      if (attempt <= retries && retryAfter > 0) { await sleep(Math.min(retryAfter, 5) * 1000); continue; }
      if (attempt <= retries && response.status >= 500) { await sleep(300 * attempt); continue; }
      return data;
    } catch (error) {
      if (attempt <= retries) { await sleep(300 * attempt); continue; }
      return { ok: false, error_code: 599, description: errorMessage(error) };
    }
  }
  return { ok: false, error_code: 599, description: "Upload failed" };
}

async function telegramCall(method, payload = {}, options = {}) {
  const retries = Number(options.retries ?? 2);
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let response;
    try {
      response = await fetch(`${TELEGRAM_API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(removeUndefined(payload))
      });
    } catch (error) {
      if (attempt <= retries) { await sleep(250 * attempt); continue; }
      return { ok: false, error_code: 599, description: errorMessage(error) };
    }
    let data;
    try { data = await response.json(); } catch { data = { ok: false, description: `Telegram HTTP ${response.status}` }; }
    if (data?.ok) return data;
    const retryAfter = Number(data?.parameters?.retry_after || 0);
    if (attempt <= retries && retryAfter > 0) { await sleep(Math.min(retryAfter, 5) * 1000); continue; }
    if (attempt <= retries && response.status >= 500) { await sleep(300 * attempt); continue; }
    return data;
  }
  return { ok: false, error_code: 599, description: "Telegram call failed" };
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined).filter(v => v !== undefined);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) output[key] = removeUndefined(item);
  return output;
}

function redactTelegramMe(response) {
  if (!response || typeof response !== "object") return response;
  return { ok: Boolean(response.ok), result: response.result ? { id: response.result.id, is_bot: response.result.is_bot, first_name: response.result.first_name, username: response.result.username } : undefined, error_code: response.error_code, description: response.description };
}

function methodHeadAware(body, headOnly = false) {
  return new Response(headOnly ? null : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function constantTimeEqualString(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function base64UrlEncodeText(text) { return base64UrlEncodeBytes(new TextEncoder().encode(text)); }
function base64UrlDecodeText(value) { return new TextDecoder().decode(base64UrlDecodeBytes(value)); }
function base64UrlEncodeBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function base64UrlDecodeBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getOriginFromSource(sourceUrl) {
  try { return new URL(sourceUrl).origin; } catch { return ""; }
}

function extractStreamIdFromText(text) {
  const match = String(text || "").match(/s:([A-Za-z0-9_-]+)/);
  return match?.[1] || null;
}

function safeUserError(error) {
  const text = errorMessage(error);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function errorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
