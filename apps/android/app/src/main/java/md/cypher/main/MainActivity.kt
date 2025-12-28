package md.cypher.main

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity

class ClipboardBridge(private val context: Context, private val webView: WebView) {
    
    @JavascriptInterface
    fun copy(text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Copied Text", text)
        clipboard.setPrimaryClip(clip)
    }
    
    @JavascriptInterface
    fun cut(text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Cut Text", text)
        clipboard.setPrimaryClip(clip)
    }
    
    @JavascriptInterface
    fun paste(): String {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return clipboard.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
    }
}

class MainActivity : ComponentActivity() {
    
    private lateinit var webView: WebView
    private lateinit var loadingScreen: View
    private lateinit var spinnerImage: ImageView
    
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        webView = findViewById(R.id.webView)
        loadingScreen = findViewById(R.id.loadingScreen)
        spinnerImage = findViewById(R.id.spinnerImage)
        
        startSpinnerAnimation()
        setupKeyboardListener()
        
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
        }
        
        webView.addJavascriptInterface(ClipboardBridge(this, webView), "AndroidClipboardBridge")
        
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                hideLoadingScreen()
            }
            
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false
            }
        }
        
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        
        webView.loadUrl("http://192.168.68.54:5173/")
    }
    
    private fun setupKeyboardListener() {
        val rootView = findViewById<View>(android.R.id.content)
        rootView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            private var wasKeyboardOpen = false
            private var previousKeypadHeight = 0
            
            override fun onGlobalLayout() {
                val r = android.graphics.Rect()
                rootView.getWindowVisibleDisplayFrame(r)
                
                val screenHeight = rootView.rootView.height
                val visibleHeight = r.height()
                val keypadHeight = screenHeight - visibleHeight
                
                val density = resources.displayMetrics.density
                val keypadHeightDp = (keypadHeight / density).toInt()
                
                val isKeyboardOpen = keypadHeight > screenHeight * 0.15
                
                if (isKeyboardOpen != wasKeyboardOpen || (isKeyboardOpen && keypadHeight != previousKeypadHeight)) {
                    wasKeyboardOpen = isKeyboardOpen
                    previousKeypadHeight = keypadHeight
                    
                    if (isKeyboardOpen) {
                        webView.evaluateJavascript(
                            "window.postMessage({type: 'keyboard-show', height: $keypadHeightDp}, '*');",
                            null
                        )
                    } else {
                        webView.evaluateJavascript(
                            "window.postMessage({type: 'keyboard-hide'}, '*');",
                            null
                        )
                    }
                }
            }
        })
    }
    
    private fun startSpinnerAnimation() {
        val rotateAnimation = RotateAnimation(
            0f, 360f,
            Animation.RELATIVE_TO_SELF, 0.5f,
            Animation.RELATIVE_TO_SELF, 0.5f
        ).apply {
            duration = 1000
            interpolator = LinearInterpolator()
            repeatCount = Animation.INFINITE
        }
        spinnerImage.startAnimation(rotateAnimation)
    }
    
    private fun hideLoadingScreen() {
        loadingScreen.animate()
            .alpha(0f)
            .setDuration(300)
            .withEndAction {
                loadingScreen.visibility = View.GONE
            }
            .start()
    }
}

