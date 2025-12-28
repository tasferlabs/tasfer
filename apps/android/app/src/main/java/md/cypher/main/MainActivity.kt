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
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ImageButton
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
    
    @JavascriptInterface
    fun updateUndoRedoState(canUndo: Boolean, canRedo: Boolean) {
        (context as? MainActivity)?.updateUndoRedoState(canUndo, canRedo)
    }
}

class MainActivity : ComponentActivity() {
    
    private lateinit var webView: WebView
    private lateinit var loadingScreen: View
    private lateinit var spinnerImage: ImageView
    private lateinit var keyboardToolbar: View
    private lateinit var blockTypeMenu: View
    
    private var canUndo = false
    private var canRedo = false
    private var isMenuOpen = false
    
    private lateinit var undoButton: ImageButton
    private lateinit var redoButton: ImageButton
    private lateinit var formatButton: ImageButton
    private lateinit var dismissButton: ImageButton
    
    fun updateUndoRedoState(canUndo: Boolean, canRedo: Boolean) {
        this.canUndo = canUndo
        this.canRedo = canRedo
        runOnUiThread {
            updateToolbarState()
        }
    }
    
    private fun updateToolbarState() {
        undoButton.isEnabled = canUndo
        redoButton.isEnabled = canRedo
        undoButton.alpha = if (canUndo) 1.0f else 0.3f
        redoButton.alpha = if (canRedo) 1.0f else 0.3f
    }
    
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        webView = findViewById(R.id.webView)
        loadingScreen = findViewById(R.id.loadingScreen)
        spinnerImage = findViewById(R.id.spinnerImage)
        keyboardToolbar = findViewById(R.id.keyboardToolbar)
        blockTypeMenu = findViewById(R.id.blockTypeMenu)
        
        setupToolbar()
        setupBlockTypeMenu()
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
        
        webView.addJavascriptInterface(ClipboardBridge(this, webView), "AndroidBridge")
        
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
                if (isMenuOpen) {
                    toggleMenu()
                } else if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        
        webView.loadUrl("http://192.168.68.54:5173/")
    }
    
    private fun setupToolbar() {
        undoButton = keyboardToolbar.findViewById(R.id.undoButton)
        redoButton = keyboardToolbar.findViewById(R.id.redoButton)
        formatButton = keyboardToolbar.findViewById(R.id.formatButton)
        dismissButton = keyboardToolbar.findViewById(R.id.dismissButton)
        
        undoButton.setOnClickListener {
            webView.evaluateJavascript(
                "if(window.AndroidBridge && window.AndroidBridge.undo) window.AndroidBridge.undo()",
                null
            )
        }
        
        redoButton.setOnClickListener {
            webView.evaluateJavascript(
                "if(window.AndroidBridge && window.AndroidBridge.redo) window.AndroidBridge.redo()",
                null
            )
        }
        
        formatButton.setOnClickListener {
            toggleMenu()
        }
        
        dismissButton.setOnClickListener {
            if (isMenuOpen) {
                toggleMenu()
            } else {
                hideKeyboard()
            }
        }
        
        updateToolbarState()
    }
    
    private fun setupBlockTypeMenu() {
        blockTypeMenu.findViewById<Button>(R.id.heading1Button).setOnClickListener {
            applyBlockType("heading1")
        }
        
        blockTypeMenu.findViewById<Button>(R.id.heading2Button).setOnClickListener {
            applyBlockType("heading2")
        }
        
        blockTypeMenu.findViewById<Button>(R.id.heading3Button).setOnClickListener {
            applyBlockType("heading3")
        }
        
        blockTypeMenu.findViewById<Button>(R.id.paragraphButton).setOnClickListener {
            applyBlockType("paragraph")
        }
    }
    
    private fun applyBlockType(type: String) {
        webView.evaluateJavascript(
            "if(window.AndroidBridge && window.AndroidBridge.setBlockType) window.AndroidBridge.setBlockType('$type')",
            null
        )
        toggleMenu()
        focusWebView()
    }
    
    private fun toggleMenu() {
        isMenuOpen = !isMenuOpen
        if (isMenuOpen) {
            hideKeyboardInput()
            
            keyboardToolbar.visibility = View.VISIBLE
            blockTypeMenu.visibility = View.VISIBLE
            dismissButton.setImageResource(R.drawable.ic_close)
            
            val density = resources.displayMetrics.density
            val menuHeightPx = (300 * density).toInt()
            
            val params = keyboardToolbar.layoutParams as android.widget.FrameLayout.LayoutParams
            params.bottomMargin = menuHeightPx
            keyboardToolbar.layoutParams = params
        } else {
            blockTypeMenu.visibility = View.GONE
            dismissButton.setImageResource(R.drawable.ic_keyboard_dismiss)
            
            val params = keyboardToolbar.layoutParams as android.widget.FrameLayout.LayoutParams
            params.bottomMargin = 0
            keyboardToolbar.layoutParams = params
            
            focusWebView()
        }
    }
    
    private fun hideKeyboardInput() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(webView.windowToken, 0)
    }
    
    private fun hideKeyboard() {
        keyboardToolbar.visibility = View.GONE
        blockTypeMenu.visibility = View.GONE
        webView.clearFocus()
    }
    
    private fun focusWebView() {
        webView.evaluateJavascript(
            "if(window.AndroidBridge && window.AndroidBridge.focus) window.AndroidBridge.focus()",
            null
        )
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
                        if (isMenuOpen) {
                            isMenuOpen = false
                            blockTypeMenu.visibility = View.GONE
                            dismissButton.setImageResource(R.drawable.ic_keyboard_dismiss)
                        }
                        
                        keyboardToolbar.visibility = View.VISIBLE
                        val params = keyboardToolbar.layoutParams as android.widget.FrameLayout.LayoutParams
                        params.bottomMargin = keypadHeight
                        keyboardToolbar.layoutParams = params
                        
                        webView.evaluateJavascript(
                            "window.postMessage({type: 'keyboard-show', height: ${keypadHeightDp + 56}}, '*');",
                            null
                        )
                    } else {
                        if (isMenuOpen) {
                            keyboardToolbar.visibility = View.VISIBLE
                            val menuHeightPx = (300 * density).toInt()
                            val params = keyboardToolbar.layoutParams as android.widget.FrameLayout.LayoutParams
                            params.bottomMargin = menuHeightPx
                            keyboardToolbar.layoutParams = params
                        } else {
                            keyboardToolbar.visibility = View.GONE
                            blockTypeMenu.visibility = View.GONE
                            
                            webView.evaluateJavascript(
                                "window.postMessage({type: 'keyboard-hide'}, '*');",
                                null
                            )
                        }
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
