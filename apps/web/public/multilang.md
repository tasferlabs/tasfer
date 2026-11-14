# Multi-language Test

Each section targets one thing that tends to break: caret movement, selection, line wrapping, bidi order, shaping, or marks. The _Check_ line under each section says what to look at.

## 1. Latin with diacritics

Français : L'été, où es-tu ? « Bonjour », ça va ?

Deutsch: Größenwahn auf der Straße. Donaudampfschifffahrtsgesellschaftskapitänsmützenhalter.

Polski: Zażółć gęślą jaźń.

Türkçe: İstanbul'da ılık bir gün. Büyük İ ile küçük ı farklı harflerdir.

Tiếng Việt: Tiếng Việt có nhiều dấu chồng lên nhau: ặ, ẫ, ổ, ự, ỡ.

_Check: the German compound wraps without overflowing; the space before "?" and inside « » in French never starts a new line._

## 2. Composed vs decomposed characters

Composed:   café, naïve, Ångström

Decomposed: café, naïve, Ångström

_Check: both lines look identical. Arrow keys step over "é" as one character on both lines, and Backspace removes the whole letter._

## 3. Greek and Cyrillic

Ελληνικά: Καλημέρα κόσμε· η ελληνική ερώτηση τελειώνει έτσι;

Русский: Съешь же ещё этих мягких французских булок, да выпей чаю.

Українська: Ґанок, їжак, єнот і щука.

## 4. Arabic

مرحبًا بكم في تسفير، محرر النصوص الذي يعمل على جهازك ويتزامن مع أصدقائك مباشرة.

هذه فقرة عربية طويلة لاختبار التفاف الأسطر. يجب أن ينتقل النص إلى السطر التالي عند حافة الصفحة اليسرى، وأن يبقى المؤشر في المكان الصحيح عند التنقل بالأسهم بين الأسطر، وأن يعمل التحديد بالفأرة وبمفتاح Shift كما هو متوقع في اللغات التي تُكتب من اليمين إلى اليسار.

بالتشكيل: اَلْعِلْمُ نُورٌ وَالْجَهْلُ ظَلَامٌ.

لام ألف: لا، السلام، الإسلام، لأن، لإن، لآن.

تطويل: مـــرحـــبـــا

أرقام هندية: ١٢٣٤٥٦٧٨٩٠ — أرقام عربية: 1234567890

_Check: letters join correctly (no isolated forms mid-word), harakat sit on their letters, and the caret never lands inside لا._

## 5. Hebrew, Persian, Urdu

עברית: שלום וברוכים הבאים לעורך הטקסט.

עם ניקוד: שָׁלוֹם עוֹלָם.

فارسی: سلام، من می‌خواهم با این ویرایشگر کار کنم. اعداد: ۱۲۳۴۵

اردو: اردو ایک خوبصورت زبان ہے۔

_Check: the Persian word with a zero-width non-joiner shows a visible break in joining, and the caret stops on both sides of it._

## 6. Mixed directions on one line

قال أحمد: "I love Tasfer" ثم ابتسم.

Version 3.1 هي الإصدار الأحدث من التطبيق.

مرحبا Hello!

سعر الكتاب 25 دولارًا، ورقم الهاتف +966 50 123 4567.

هذا نص (بين قوسين) وهذا [بين معقوفين] وهذا {بين حاصرتين}.

زر الموقع https://example.com/ar?page=2 للمزيد.

המחיר הוא 1,234.56 ₪ כולל מע״מ.

العربية والעברית في سطر واحد مع English أيضًا.

123 — 456 ... !!!

_Check: brackets mirror correctly in RTL, the "!" after "Hello" sits at the far left (end of an RTL line), the phone number shows as "4567 123 50 966+" like in a browser, numbers read left to right, and Shift+Arrow selection across a direction change grows from the caret._

## 7. Marks across scripts

**نص عريض** و*نص مائل* و`كود مضمّن` و~~نص مشطوب~~ و[رابط عربي](https://example.com).

**טקסט מודגש** ו*נטוי* ו[קישור](https://example.com).

**Bold that runs into عربي داخل الخط العريض** then plain.

*斜体中文* 和 **粗体日本語** と `インラインコード`。

_Check: a mark that crosses a direction change paints as one run, and typing at its edge keeps or drops the mark the same way it does in English._

## 8. Chinese, Japanese, Korean

简体中文：你好，世界！这是一段用于测试换行的中文文本。中文句子之间通常没有空格，所以编辑器需要在任意两个汉字之间断行，同时避免让句号或逗号出现在行首。

繁體中文：臺灣與香港使用繁體字。

日本語：こんにちは、世界。日本語はひらがな・カタカナ・漢字を混ぜて書きます。行頭に「。」や「、」が来ないように改行される必要があります。

한국어: 안녕하세요, 세계! 한국어는 띄어쓰기를 사용하며, 단어 단위로 줄을 바꿉니다.

Mixed: 我在用 Tasfer 写笔记，版本 2.0，速度很快。

_Check: no line starts with 。、，; Korean wraps at spaces, not mid-word; double-click picks a sensible word in each._

## 9. South and Southeast Asian scripts

हिन्दी: नमस्ते दुनिया। संयुक्ताक्षर: क्ष, त्र, ज्ञ, श्र, द्ध।

বাংলা: আমি বাংলায় গান গাই।

தமிழ்: வணக்கம் உலகம்.

ไทย: สวัสดีชาวโลก ภาษาไทยไม่มีการเว้นวรรคระหว่างคำ จึงต้องตัดบรรทัดตามคำในพจนานุกรม ผู้ใหญ่ กิ๊ก

ខ្មែរ: សួស្តីពិភពលោក

မြန်မာ: မင်္ဂလာပါ

_Check: conjuncts render as one shape, the caret never splits a cluster, Thai wraps between words instead of mid-word, and stacked Thai marks don't overlap the line above._

## 10. Other scripts

ქართული: გამარჯობა, მსოფლიო!

Հայերեն: Բարեւ աշխարհ։

አማርኛ: ሰላም ለዓለም።

## 11. Emoji

Family 👨‍👩‍👧‍👦 coder 👩🏽‍💻 flag 🏳️‍🌈 🇸🇦 🇯🇵 keycap 1️⃣ heart ❤️ vs ❤ melting 🫠

مرحبا 👋 بالعالم 🌍

_Check: each emoji is one caret step and one Backspace; skin tones and ZWJ sequences don't split._

## 12. Lists, todos, quotes in RTL

- العنصر الأول
- العنصر الثاني مع English في المنتصف
  - عنصر فرعي
  - פריט משנה בעברית

1. الخطوة الأولى
2. الخطوة الثانية
3. الخطوة الثالثة

- [ ] مهمة لم تُنجز بعد
- [x] مهمة منجزة
- [ ] Task in English
- [ ] 中文任务

> الحكمة ضالة المؤمن، أنّى وجدها فهو أحق بها.

> ציטוט בעברית בתוך בלוק ציטוט.

_Check: bullets, numbers, and checkboxes sit on the right side for RTL items and on the left for LTR ones._

## 13. Table

| اللغة   | Language | تحية       | Direction |
| ------- | -------- | ---------- | --------- |
| العربية | Arabic   | مرحبا      | RTL       |
| עברית   | Hebrew   | שלום       | RTL       |
| 日本語  | Japanese | こんにちは | LTR       |
| हिन्दी  | Hindi    | नमस्ते     | LTR       |
| ไทย     | Thai     | สวัสดี     | LTR       |

## 14. Code

```js
// تعليق بالعربية داخل الكود
const greeting = "مرحبا بالعالم"; // Arabic string
const 名前 = "東京";
const shalom = "שלום"; // Hebrew string
```

_Check: code stays left to right even when strings and comments are RTL._

## 15. Math

معادلة فيثاغورس: $a^2 + b^2 = c^2$ في المثلث القائم الزاوية.

מעגל: $A = \pi r^2$ הוא שטח העיגול.

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

$$
\text{المساحة} = \pi r^2
$$

_Check: inline math sits in the right place inside RTL sentences; the formula itself stays left to right._

## 16. Invisible characters and long strings

No-break space: 10 kg and 100 km/h never split across lines.

Soft hyphen: super­cali­fragilistic­expiali­docious

Zero-width space: Zero​Width​Space​Between​Every​Word​Here

Long word: Pneumonoultramicroscopicsilicovolcanoconiosis

Long URL: https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces/at/all?query=value&another=value

كلمة عربية طويلة بلا مسافات: أفاستسقيناكموها

_Check: soft hyphens only show a "-" when the word breaks at them; long words and URLs wrap instead of running off the page._
