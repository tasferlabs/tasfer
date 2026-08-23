/**
 * CLI message catalogue.
 *
 * The app's i18next catalogue is product copy loaded over HTTP by a browser;
 * these are operator messages printed to a terminal, so they live here instead
 * of being bundled into it. The vocabulary is deliberately the app's, so the
 * two read as one product: مُرحِّل for relay, نظير for peer, مساحة for space,
 * جهاز for device, رمز for code.
 *
 * Locale comes from `--lang`, then `TASFER_LANG`, then the POSIX locale
 * environment. An unknown language falls back to English, and so does any key
 * a translation has not caught up with.
 */

export type Lang = "en" | "ar";

const EN = {
  // ─── Usage ────────────────────────────────────────────────────────────────
  "usage.summary": "tasfer — run a Tasfer host or relay on your own machine",
  "usage.commands": "Commands",
  "usage.host": "Run the headless host: stay online and sync your spaces",
  "usage.hostLink": "Link this host to your account with a code from the app",
  "usage.hostInvite": "Show a code the app can use to link this host",
  "usage.hostStatus": "Print what this host holds and who it belongs to",
  "usage.relay": "Run the signaling relay peers use to find each other",
  "usage.options": "Options",
  "usage.optDataDir": "Where the database and assets live",
  "usage.optSignalUrl": "Relay to reach peers through",
  "usage.optTransport":
    "auto (direct if available), direct, or relay-only",
  "usage.optName": "Label for this host in your device list",
  "usage.optTtl": "How long the code stays valid, in minutes",
  "usage.optPort": "Port to listen on",
  "usage.optHost": "Address to bind — 0.0.0.0 to accept from anywhere",
  "usage.optTurnUrl":
    "TURN server URL peers should use, e.g. turn:turn.example.org:3478",
  "usage.optTurnSecret":
    "coturn shared secret (static-auth-secret) for minting credentials",
  "usage.optTurnTtl": "Lifetime of a minted TURN credential, in seconds",
  "usage.optLang": "Language for this output (en, ar)",
  "usage.optHelp": "Show this help",
  "usage.optVersion": "Show the version",
  "usage.more": "Docs: https://tasfer.app/docs/app/self-hosting",

  // ─── Host ─────────────────────────────────────────────────────────────────
  "host.dataDir": "Data directory: {{path}}",
  "host.relay": "Relay: {{url}}",
  "host.device": "This device: {{key}}",
  "host.transportDirect": "Transport: direct connections, relay as fallback",
  "host.transportRelay":
    "Transport: relay only — install node-datachannel for direct connections",
  "host.transportRelayChosen": "Transport: relay only, as requested",
  "host.holding": "Holding {{spaces}} and {{pages}}.",
  "host.spaceCount_one": "{{count}} space",
  "host.spaceCount_other": "{{count}} spaces",
  "host.pageCount_one": "{{count}} page",
  "host.pageCount_other": "{{count}} pages",
  "host.notLinked":
    "This host is not linked to your account yet, so it has nothing to sync. Run `tasfer host link <code>` with a code from the app.",
  "host.online": "Host is online. Press Ctrl+C to stop.",
  "host.peerConnected": "Peer connected: {{peer}}",
  "host.peerDisconnected": "Peer disconnected: {{peer}}",
  "host.stopping": "Stopping — finishing the round in flight…",
  "host.stopped": "Stopped.",

  // ─── Linking ──────────────────────────────────────────────────────────────
  "link.needCode": "Pass the code from the app: tasfer host link <code>",
  "link.invalidCode": "That code isn't valid. Check for missing characters.",
  "link.expiredCode": "This code has expired. Generate a new one.",
  "link.waiting": "Waiting for the other device — keep the app open.",
  "link.connected": "Connected — proving the code…",
  "link.peer": "Other device: {{peer}}",
  "link.enrolling": "Setting up this host…",
  "link.handingOver": "Handing over your identity and spaces…",
  "link.reconnecting": "The connection dropped. Trying again…",
  "link.linkedDevice": "Linked. Your spaces are syncing to this host now.",
  "link.joinedSpace": "Joined {{space}}.",
  "link.joinedSpaceUnnamed": "Joined the space.",
  "link.failed": "Linking failed: {{reason}}",
  "link.timedOut":
    "Gave up waiting for the other device. Check both are online and try again.",
  "link.alreadyLinked":
    "This host already belongs to an account. Delete its data directory first to link it to another.",

  // ─── Inviting ─────────────────────────────────────────────────────────────
  "invite.code": "Enter this code in the app under Profile → Link a device:",
  "invite.expires": "It expires in {{minutes}} minutes.",
  "invite.warning":
    "Anyone who uses the code gets full access to everything you have written, until it expires.",
  "invite.linked": "Linked {{peer}}.",

  // ─── Status ───────────────────────────────────────────────────────────────
  "status.person": "Person: {{name}}",
  "status.personUnnamed": "(unnamed)",
  "status.rootKey": "Identity: {{key}}",
  "status.standalone":
    "Standalone — this host has its own identity and is not linked to any account.",
  "status.devices": "Devices",
  "status.deviceSelf": "{{key}} — this host{{note}}",
  "status.deviceOther": "{{key}}{{note}}",
  "status.spaces": "Spaces",
  "status.spaceLine": "{{name}} — {{pages}}",
  "status.noSpaces": "No spaces yet.",

  // ─── Pairing failures (worded as in the app) ──────────────────────────────
  "pair.expired":
    "The code expired before the two devices met. Generate a new one.",
  "pair.network":
    "Could not reach the other device. Check both are online and try again.",
  "pair.invalid-proof":
    "That code did not check out. Copy it again from the other device.",
  "pair.certificate":
    "This device could not vouch for the other one. Try linking again.",
  "pair.enrollment":
    "The connection worked but the handover did not finish. Try linking again.",
  "pair.no-root-identity":
    "This device has no identity to share yet. Finish setting it up first.",
  "pair.bad-device-key":
    "The other device identified itself in a way this one cannot accept.",
  "pair.generic": "Linking failed. Try again.",

  // ─── Relay ────────────────────────────────────────────────────────────────
  "relay.listening": "Relay listening on {{url}}",
  "relay.pointApps": "Point the app at it by building with VITE_SIGNAL_URL={{url}}",
  "relay.turnCoturn": "TURN: minting credentials for {{url}}",
  "relay.turnCloudflare": "TURN: Cloudflare Calls",
  "relay.turnNone":
    "TURN: none configured — peers behind strict NAT fall back to relaying through this server",
  "relay.turnSecretMissing":
    "--turn-url needs --turn-secret (coturn's static-auth-secret) to mint credentials.",
  "relay.stopping": "Stopping the relay…",
  "relay.stopped": "Relay stopped.",

  // ─── Errors ───────────────────────────────────────────────────────────────
  "error.unknownCommand": "Unknown command: {{command}}",
  "error.unknownOption": "Unknown option: {{option}}",
  "error.optionNeedsValue": "{{option}} needs a value",
  "error.badNumber": "{{option}} must be a number, got: {{value}}",
  "error.tryHelp": "Run `tasfer --help` to see what is available.",
} as const;

export type MessageKey = keyof typeof EN;

/**
 * The stem of a `_one`/`_other` pair. Callers pass the stem plus a `count`
 * and {@link t} picks the form.
 */
export type PluralKey =
  MessageKey extends infer K
    ? K extends `${infer Stem}_other`
      ? Stem
      : never
    : never;

/**
 * Meaning-based Arabic, not word-for-word: the terminal reads as a person
 * talking, the way the app's copy does.
 */
const AR: Partial<Record<MessageKey, string>> = {
  "usage.summary": "tasfer — شغّل مضيف تصفير أو مُرحِّله على جهازك",
  "usage.commands": "الأوامر",
  "usage.host": "شغّل المضيف بلا واجهة: يبقى متصلًا ويزامن مساحاتك",
  "usage.hostLink": "اربط هذا المضيف بحسابك برمز من التطبيق",
  "usage.hostInvite": "اعرض رمزًا يستخدمه التطبيق لربط هذا المضيف",
  "usage.hostStatus": "اعرض ما يحتفظ به هذا المضيف ولمن يتبع",
  "usage.relay": "شغّل مُرحِّل الإشارة الذي يجد الأقران بعضهم من خلاله",
  "usage.options": "الخيارات",
  "usage.optDataDir": "مكان قاعدة البيانات والمرفقات",
  "usage.optSignalUrl": "المُرحِّل الذي تصل إلى الأقران عبره",
  "usage.optTransport": "auto (مباشر إن أمكن) أو direct أو relay فقط",
  "usage.optName": "اسم هذا المضيف في قائمة أجهزتك",
  "usage.optTtl": "مدة صلاحية الرمز بالدقائق",
  "usage.optPort": "المنفذ الذي يستمع عليه",
  "usage.optHost": "العنوان الذي يرتبط به — 0.0.0.0 للقبول من أي مكان",
  "usage.optTurnUrl":
    "عنوان خادم TURN الذي يستخدمه الأقران، مثل turn:turn.example.org:3478",
  "usage.optTurnSecret": "سر coturn المشترك (static-auth-secret) لإصدار البيانات",
  "usage.optTurnTtl": "مدة صلاحية بيانات TURN المُصدَرة بالثواني",
  "usage.optLang": "لغة هذه المخرجات (en أو ar)",
  "usage.optHelp": "اعرض هذه المساعدة",
  "usage.optVersion": "اعرض الإصدار",
  "usage.more": "التوثيق: https://tasfer.app/docs/app/self-hosting",

  "host.dataDir": "مجلد البيانات: {{path}}",
  "host.relay": "المُرحِّل: {{url}}",
  "host.device": "هذا الجهاز: {{key}}",
  "host.transportDirect": "الاتصال: مباشر، والمُرحِّل بديل عند التعذّر",
  "host.transportRelay":
    "الاتصال: عبر المُرحِّل فقط — ثبّت node-datachannel للاتصال المباشر",
  "host.transportRelayChosen": "الاتصال: عبر المُرحِّل فقط، كما طُلب",
  "host.holding": "يحتفظ بـ {{spaces}} و{{pages}}.",
  "host.spaceCount_one": "مساحة واحدة",
  "host.spaceCount_other": "{{count}} مساحة",
  "host.pageCount_one": "صفحة واحدة",
  "host.pageCount_other": "{{count}} صفحة",
  "host.notLinked":
    "هذا المضيف غير مرتبط بحسابك بعد، فليس لديه ما يزامنه. نفّذ `tasfer host link <code>` برمز من التطبيق.",
  "host.online": "المضيف متصل. اضغط Ctrl+C للإيقاف.",
  "host.peerConnected": "اتصل نظير: {{peer}}",
  "host.peerDisconnected": "انقطع نظير: {{peer}}",
  "host.stopping": "جارٍ الإيقاف — إتمام الجولة الجارية…",
  "host.stopped": "توقّف.",

  "link.needCode": "مرّر الرمز من التطبيق: tasfer host link <code>",
  "link.invalidCode": "هذا الرمز غير صالح. تحقّق من عدم نقص أي حرف.",
  "link.expiredCode": "انتهت صلاحية هذا الرمز. أنشئ رمزًا جديدًا.",
  "link.waiting": "في انتظار الجهاز الآخر — أبقِ التطبيق مفتوحًا.",
  "link.connected": "تم الاتصال — جارٍ التحقق من الرمز…",
  "link.peer": "الجهاز الآخر: {{peer}}",
  "link.enrolling": "جارٍ تجهيز هذا المضيف…",
  "link.handingOver": "جارٍ تسليم هويتك ومساحاتك…",
  "link.reconnecting": "انقطع الاتصال. جارٍ المحاولة من جديد…",
  "link.linkedDevice": "تم الربط. تجري الآن مزامنة مساحاتك إلى هذا المضيف.",
  "link.joinedSpace": "انضممت إلى {{space}}.",
  "link.joinedSpaceUnnamed": "انضممت إلى المساحة.",
  "link.failed": "تعذّر الربط: {{reason}}",
  "link.timedOut":
    "انتهى انتظار الجهاز الآخر. تأكد من اتصال الجهازين بالشبكة وأعد المحاولة.",
  "link.alreadyLinked":
    "هذا المضيف يتبع حسابًا بالفعل. احذف مجلد بياناته أولًا لربطه بحساب آخر.",

  "invite.code": "أدخل هذا الرمز في التطبيق من الملف الشخصي ← ربط جهاز:",
  "invite.expires": "تنتهي صلاحيته خلال {{minutes}} دقيقة.",
  "invite.warning":
    "من يستخدم هذا الرمز يحصل على وصول كامل إلى كل ما كتبته، إلى أن تنتهي صلاحيته.",
  "invite.linked": "تم ربط {{peer}}.",

  "status.person": "الشخص: {{name}}",
  "status.personUnnamed": "(بلا اسم)",
  "status.rootKey": "الهوية: {{key}}",
  "status.standalone": "مستقل — لهذا المضيف هويته الخاصة وليس مرتبطًا بأي حساب.",
  "status.devices": "الأجهزة",
  "status.deviceSelf": "{{key}} — هذا المضيف{{note}}",
  "status.deviceOther": "{{key}}{{note}}",
  "status.spaces": "المساحات",
  "status.spaceLine": "{{name}} — {{pages}}",
  "status.noSpaces": "لا توجد مساحات بعد.",

  "pair.expired": "انتهت صلاحية الرمز قبل أن يتصل الجهازان. أنشئ رمزًا جديدًا.",
  "pair.network":
    "تعذّر الوصول إلى الجهاز الآخر. تأكد من اتصال الجهازين بالشبكة وأعد المحاولة.",
  "pair.invalid-proof": "هذا الرمز غير مطابق. انسخه مرة أخرى من الجهاز الآخر.",
  "pair.certificate": "تعذّر على هذا الجهاز التحقق من الجهاز الآخر. أعد محاولة الربط.",
  "pair.enrollment":
    "نجح الاتصال، لكن لم يكتمل نقل هويتك ومساحاتك. أعد محاولة الربط.",
  "pair.no-root-identity": "لا يملك هذا الجهاز هوية يشاركها بعد. أكمل الإعداد أولًا.",
  "pair.bad-device-key": "عرّف الجهاز الآخر بنفسه بطريقة لا يقبلها هذا الجهاز.",
  "pair.generic": "تعذّر الربط. أعد المحاولة.",

  "relay.listening": "المُرحِّل يستمع على {{url}}",
  "relay.pointApps": "وجّه التطبيق إليه بالبناء باستخدام VITE_SIGNAL_URL={{url}}",
  "relay.turnCoturn": "TURN: يصدر بيانات اعتماد لـ {{url}}",
  "relay.turnCloudflare": "TURN: عبر Cloudflare Calls",
  "relay.turnNone":
    "TURN: غير مُهيّأ — الأقران خلف NAT صارم سيمرّرون بياناتهم عبر هذا الخادم",
  "relay.turnSecretMissing":
    "‏--turn-url يحتاج إلى ‎--turn-secret (سر coturn المشترك) لإصدار البيانات.",
  "relay.stopping": "جارٍ إيقاف المُرحِّل…",
  "relay.stopped": "توقّف المُرحِّل.",

  "error.unknownCommand": "أمر غير معروف: {{command}}",
  "error.unknownOption": "خيار غير معروف: {{option}}",
  "error.optionNeedsValue": "{{option}} يحتاج إلى قيمة",
  "error.badNumber": "{{option}} يجب أن يكون رقمًا، والقيمة المعطاة: {{value}}",
  "error.tryHelp": "نفّذ `tasfer --help` لعرض ما هو متاح.",
};

const CATALOGUES: Record<Lang, Partial<Record<MessageKey, string>>> = {
  en: EN,
  ar: AR,
};

let current: Lang = "en";

/** Resolve and remember the output language for this process. */
export function setLanguage(explicit?: string): Lang {
  const raw =
    explicit ??
    process.env.TASFER_LANG ??
    process.env.LC_ALL ??
    process.env.LANG ??
    "";
  current = raw.toLowerCase().startsWith("ar") ? "ar" : "en";
  return current;
}

export function language(): Lang {
  return current;
}

/**
 * A message, interpolated. `count` also selects the `_one`/`_other` form, the
 * same two-form split the app's catalogue uses — Arabic's finer plural
 * categories are handled by wording that reads correctly with a number in
 * front of it, not by more keys.
 */
export function t(
  key: MessageKey | PluralKey,
  params: Record<string, string | number> = {},
): string {
  let resolved = key as MessageKey;
  if (typeof params.count === "number") {
    const plural = `${key}_${params.count === 1 ? "one" : "other"}`;
    if (plural in EN) resolved = plural as MessageKey;
  }

  const template = CATALOGUES[current][resolved] ?? EN[resolved] ?? resolved;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
