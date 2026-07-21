# R8 rules for the release build.
#
# Most of what this app exposes reflectively is already covered, so keep this
# file small and justify every addition:
#
#   - @JavascriptInterface methods on AndroidBridge are kept by AGP's
#     proguard-android-optimize.txt. The class itself may be renamed; JS reaches
#     it through the addJavascriptInterface name, not the class name.
#   - Capacitor plugins (SqlitePlugin, and the classpath entries in
#     assets/capacitor.plugins.json, which are loaded by name) are kept by the
#     consumer rules @capacitor/android ships.

# PdfRenderer subclasses PrintDocumentAdapter's result callbacks through a shim
# declared in the framework's own android.print package, because their
# constructors are package-private. That hierarchy is unusual enough that it is
# worth pinning rather than trusting R8 to infer it.
-keep class android.print.PdfCallbacks { *; }
-keep class android.print.PdfCallbacks$* { *; }
