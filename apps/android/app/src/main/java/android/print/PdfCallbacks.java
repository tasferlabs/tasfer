package android.print;

// Shim: PrintDocumentAdapter.LayoutResultCallback / WriteResultCallback have
// package-private constructors, so Kotlin cannot subclass them directly. By
// living in android.print, this Java file can subclass them and re-expose
// public no-arg constructors that Kotlin code can extend.
public final class PdfCallbacks {
    private PdfCallbacks() {}

    public static abstract class Layout extends PrintDocumentAdapter.LayoutResultCallback {
        public Layout() { super(); }
    }

    public static abstract class Write extends PrintDocumentAdapter.WriteResultCallback {
        public Write() { super(); }
    }
}
