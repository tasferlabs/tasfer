package android.print;

// This a shim (replacement  code) so we can expose teh pdf callbacks to kotlin
public final class PdfCallbacks {
    private PdfCallbacks() {}

    public static abstract class Layout extends PrintDocumentAdapter.LayoutResultCallback {
        public Layout() { super(); }
    }

    public static abstract class Write extends PrintDocumentAdapter.WriteResultCallback {
        public Write() { super(); }
    }
}
