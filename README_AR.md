# مشروع Virtual Fit بسيط لمتجر Laveen Abaya

هذا المشروع مخصص لمتجر:
https://laveenabaya.com

## الملفات
- `index.html` : صفحة التجربة الافتراضية
- `api/tryon.js` : ربط FASHN API
- `vercel.json` : إعداد تشغيل Vercel
- `salla-button-snippet.html` : الكود الذي تلصقه داخل سلة

## طريقة التشغيل
1. ارفع المشروع إلى GitHub.
2. اربطه مع Vercel.
3. أضف متغير البيئة:
   - `FASHN_API_KEY`
4. انشر المشروع.
5. خذ رابط Vercel وضعه بدل:
   - `https://YOUR-VERCEL-DOMAIN.vercel.app`
   داخل ملف `salla-button-snippet.html`
6. الصق كود الزر داخل سلة في صفحة المنتج أو في تخصيص الأكواد.

## اختبار يدوي
افتح الرابط بهذا الشكل:

`https://YOUR-VERCEL-DOMAIN.vercel.app/?title=LA149&product_url=https://laveenabaya.com/en/YgrwQNo&image=https://example.com/image.jpg`

## ملاحظات
- قد تحتاج تعديل محدد صورة المنتج داخل سلة إذا لم تُلتقط الصورة بشكل صحيح.
- إن لم تنجح المعاينة من أول مرة، راقب Logs في Vercel.
- هذا المشروع للانطلاق السريع، وليس نسخة إنتاجية متقدمة.
