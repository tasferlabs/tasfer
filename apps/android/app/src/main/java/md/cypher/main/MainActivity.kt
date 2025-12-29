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

class AndroidBridge(private val context: Context, private val webView: WebView) {
    
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
        // This will be called from web to update undo/redo button states
        // We'll handle this in the activity
        (context as? MainActivity)?.updateUndoRedoButtons(canUndo, canRedo)
    }
}

class MainActivity : ComponentActivity() {
    
    private lateinit var webView: WebView
    private lateinit var loadingScreen: View
    private lateinit var spinnerImage: ImageView
    
    // Toolbar elements
    private lateinit var keyboardToolbar: View
    private lateinit var undoButton: ImageButton
    private lateinit var redoButton: ImageButton
    private lateinit var formatButton: ImageButton
    private lateinit var dismissButton: ImageButton
    
    // Block type menu elements
    private lateinit var blockTypeMenu: View
    private lateinit var heading1Button: Button
    private lateinit var heading2Button: Button
    private lateinit var heading3Button: Button
    private lateinit var paragraphButton: Button
    
    // State tracking
    private var isBlockMenuOpen = false
    private var keyboardHeight = 0
    
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        // Initialize views
        webView = findViewById(R.id.webView)
        loadingScreen = findViewById(R.id.loadingScreen)
        spinnerImage = findViewById(R.id.spinnerImage)
        
        // Initialize toolbar
        keyboardToolbar = findViewById(R.id.keyboardToolbar)
        undoButton = keyboardToolbar.findViewById(R.id.undoButton)
        redoButton = keyboardToolbar.findViewById(R.id.redoButton)
        formatButton = keyboardToolbar.findViewById(R.id.formatButton)
        dismissButton = keyboardToolbar.findViewById(R.id.dismissButton)
        
        // Initialize block type menu
        blockTypeMenu = findViewById(R.id.blockTypeMenu)
        heading1Button = blockTypeMenu.findViewById(R.id.heading1Button)
        heading2Button = blockTypeMenu.findViewById(R.id.heading2Button)
        heading3Button = blockTypeMenu.findViewById(R.id.heading3Button)
        paragraphButton = blockTypeMenu.findViewById(R.id.paragraphButton)
        
        startSpinnerAnimation()
        setupKeyboardListener()
        setupToolbarListeners()
        setupBlockMenuListeners()
        
        // Disable WebView scrollbars - let web content handle scrolling
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
        }
        
        // Add AndroidBridge (which includes clipboard functions)
        webView.addJavascriptInterface(AndroidBridge(this, webView), "AndroidBridge")
        
        // Inject editor methods that native can call
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
                if (isBlockMenuOpen) {
                    // Close block menu and return to keyboard
                    closeBlockMenu()
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
    
    private fun setupToolbarListeners() {
        // Undo button
        undoButton.setOnClickListener {
            webView.evaluateJavascript("window.AndroidBridge?.undo?.()", null)
        }
        
        // Redo button
        redoButton.setOnClickListener {
            webView.evaluateJavascript("window.AndroidBridge?.redo?.()", null)
        }
        
        // Format button - opens block type menu
        formatButton.setOnClickListener {
            openBlockMenu()
        }
        
        // Dismiss button - behavior depends on mode
        dismissButton.setOnClickListener {
            if (isBlockMenuOpen) {
                // In block menu mode: return to keyboard
                closeBlockMenu()
            } else {
                // In keyboard mode: hide keyboard and all editing UI
                hideKeyboard()
                hideEditingUI()
            }
        }
    }
    
    private fun setupBlockMenuListeners() {
        heading1Button.setOnClickListener {
            setBlockType("heading1")
            closeBlockMenu()
        }
        
        heading2Button.setOnClickListener {
            setBlockType("heading2")
            closeBlockMenu()
        }
        
        heading3Button.setOnClickListener {
            setBlockType("heading3")
            closeBlockMenu()
        }
        
        paragraphButton.setOnClickListener {
            setBlockType("paragraph")
            closeBlockMenu()
        }
    }
    
    private fun setBlockType(type: String) {
        webView.evaluateJavascript("window.AndroidBridge?.setBlockType?.('$type')", null)
    }
    
    private fun openBlockMenu() {
        isBlockMenuOpen = true
        
        // Hide keyboard
        hideKeyboard()
        
        // Adjust block menu height to match keyboard and position it
        val menuParams = blockTypeMenu.layoutParams as android.widget.RelativeLayout.LayoutParams
        menuParams.height = keyboardHeight
        menuParams.bottomMargin = 0  // Block menu sits right at bottom
        blockTypeMenu.layoutParams = menuParams
        
        // Show block menu
        blockTypeMenu.visibility = View.VISIBLE
        
        // Adjust toolbar to sit above block menu
        val toolbarParams = keyboardToolbar.layoutParams as android.widget.RelativeLayout.LayoutParams
        toolbarParams.bottomMargin = keyboardHeight
        keyboardToolbar.layoutParams = toolbarParams
    }
    
    private fun closeBlockMenu() {
        isBlockMenuOpen = false
        
        // Reset block menu margin
        val menuParams = blockTypeMenu.layoutParams as android.widget.RelativeLayout.LayoutParams
        menuParams.bottomMargin = 0
        blockTypeMenu.layoutParams = menuParams
        
        // Hide block menu
        blockTypeMenu.visibility = View.GONE
        
        // Show keyboard again
        showKeyboard()
        
        // Toolbar will be repositioned by keyboard listener when keyboard reappears
    }
    
    private fun showKeyboard() {
        webView.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)
    }
    
    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(webView.windowToken, 0)
    }
    
    private fun hideEditingUI() {
        // Reset toolbar margin
        val toolbarParams = keyboardToolbar.layoutParams as android.widget.RelativeLayout.LayoutParams
        toolbarParams.bottomMargin = 0
        keyboardToolbar.layoutParams = toolbarParams
        
        // Hide toolbar
        keyboardToolbar.visibility = View.GONE
        
        // Hide block menu if open
        if (isBlockMenuOpen) {
            val menuParams = blockTypeMenu.layoutParams as android.widget.RelativeLayout.LayoutParams
            menuParams.bottomMargin = 0
            blockTypeMenu.layoutParams = menuParams
            blockTypeMenu.visibility = View.GONE
            isBlockMenuOpen = false
        }
        
        // Clear focus from webview
        webView.clearFocus()
    }
    
    private fun showEditingUI() {
        // Show toolbar
        keyboardToolbar.visibility = View.VISIBLE
    }
    
    fun updateUndoRedoButtons(canUndo: Boolean, canRedo: Boolean) {
        runOnUiThread {
            undoButton.isEnabled = canUndo
            undoButton.alpha = if (canUndo) 1.0f else 0.4f
            
            redoButton.isEnabled = canRedo
            redoButton.alpha = if (canRedo) 1.0f else 0.4f
        }
    }
    
    private fun setupKeyboardListener() {
        val rootView = findViewById<View>(android.R.id.content)
        rootView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            private var wasKeyboardOpen = false
            private var previousKeypadHeight = 0
            
            override fun onGlobalLayout() {
                // Don't process keyboard changes if block menu is open
                if (isBlockMenuOpen) {
                    return
                }
                
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
                    keyboardHeight = keypadHeight
                    
                    if (isKeyboardOpen) {
                        // Show toolbar above keyboard
                        showEditingUI()
                        
                        // Position toolbar above keyboard using margin
                        val layoutParams = keyboardToolbar.layoutParams as android.widget.RelativeLayout.LayoutParams
                        layoutParams.bottomMargin = keypadHeight
                        keyboardToolbar.layoutParams = layoutParams
                        
                        // Notify web of keyboard height (including toolbar)
                        keyboardToolbar.post {
                            val toolbarHeightDp = (keyboardToolbar.height / density).toInt()
                            val totalHeightDp = keypadHeightDp + toolbarHeightDp
                            webView.evaluateJavascript(
                                "window.postMessage({type: 'keyboard-show', height: $totalHeightDp}, '*');",
                                null
                            )
                        }
                    } else {
                        // Keyboard closed - hide editing UI
                        hideEditingUI()
                        
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
