package md.cypher.main

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import androidx.core.graphics.Insets

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
    
    @JavascriptInterface
    fun haptic(style: String) {
        (context as? MainActivity)?.triggerHaptic(style)
    }
    
    @JavascriptInterface
    fun setEditorFocused(focused: Boolean) {
        (context as? MainActivity)?.updateEditorFocus(focused)
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
    private var bottomInset = 0
    private var topInset = 0
    private var isEditorFocused = false  // Track if canvas editor is focused
    
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)
        
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
        setupWindowInsets()
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
                // Inject safe area insets when page finishes loading
                injectSafeAreaInsets()
            }
            
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false
            }
            
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                // Trust self-signed SSL certificates for development only
                // Accept certificates from local development servers
                val url = error?.url ?: ""
                if (url.contains("localhost") || url.contains("127.0.0.1") || url.contains("10.0.2.2") || 
                    url.startsWith("https://192.168.")) {
                    handler?.proceed()
                } else {
                    // For production URLs, cancel on SSL errors
                    handler?.cancel()
                }
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
        
        // Use 10.0.2.2 for Android emulator to access host machine's localhost
        webView.loadUrl("https://192.168.68.53:5173/")
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
        menuParams.bottomMargin = bottomInset  // Account for system navigation bar
        blockTypeMenu.layoutParams = menuParams
        
        // Show block menu
        blockTypeMenu.visibility = View.VISIBLE
        
        // Adjust toolbar to sit above block menu
        val toolbarParams = keyboardToolbar.layoutParams as android.widget.RelativeLayout.LayoutParams
        toolbarParams.bottomMargin = keyboardHeight + bottomInset
        keyboardToolbar.layoutParams = toolbarParams
    }
    
    private fun closeBlockMenu() {
        isBlockMenuOpen = false
        
        // Reset block menu margin
        val menuParams = blockTypeMenu.layoutParams as android.widget.RelativeLayout.LayoutParams
        menuParams.bottomMargin = bottomInset
        blockTypeMenu.layoutParams = menuParams
        
        // Hide block menu
        blockTypeMenu.visibility = View.GONE
        
        // Show keyboard again
        showKeyboard()
        
        // Toolbar will be repositioned by insets listener when keyboard reappears
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
    
    private fun hideToolbarOnly() {
        // Reset toolbar margin to account for bottom inset
        val toolbarParams = keyboardToolbar.layoutParams as android.widget.RelativeLayout.LayoutParams
        toolbarParams.bottomMargin = bottomInset
        keyboardToolbar.layoutParams = toolbarParams
        
        // Hide toolbar
        keyboardToolbar.visibility = View.GONE
        
        // Hide block menu if open
        if (isBlockMenuOpen) {
            val menuParams = blockTypeMenu.layoutParams as android.widget.RelativeLayout.LayoutParams
            menuParams.bottomMargin = bottomInset
            blockTypeMenu.layoutParams = menuParams
            blockTypeMenu.visibility = View.GONE
            isBlockMenuOpen = false
        }
    }
    
    private fun hideEditingUI() {
        // Hide toolbar and menus
        hideToolbarOnly()
        
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
    
    fun updateEditorFocus(focused: Boolean) {
        runOnUiThread {
            isEditorFocused = focused
        }
    }
    
    private fun injectSafeAreaInsets() {
        val density = resources.displayMetrics.density
        val topInsetPx = (topInset / density)
        val bottomInsetPx = (bottomInset / density)
        
        webView.evaluateJavascript("""
            (function() {
                if (document.documentElement) {
                    document.documentElement.style.setProperty('--safe-area-inset-top', '${topInsetPx}px');
                    document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottomInsetPx}px');
                    document.documentElement.style.setProperty('--safe-area-inset-left', '0px');
                    document.documentElement.style.setProperty('--safe-area-inset-right', '0px');
                }
            })();
        """.trimIndent(), null)
    }

    private fun setupWindowInsets() {
        val rootView = findViewById<View>(android.R.id.content)

        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, windowInsets ->
            val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())

            // Store system insets
            topInset = systemBars.top
            bottomInset = systemBars.bottom
            
            // Inject safe area insets as CSS custom properties for the web app
            // Android WebView doesn't support env(safe-area-inset-*) natively
            injectSafeAreaInsets()

            val density = resources.displayMetrics.density

            // Don't process keyboard changes if block menu is open
            if (!isBlockMenuOpen) {
                val isKeyboardVisible = ime.bottom > bottomInset

                if (isKeyboardVisible) {
                    // Calculate actual keyboard height (excluding system navigation bar)
                    keyboardHeight = ime.bottom - bottomInset

                    // Only show toolbar if canvas editor is focused
                    if (isEditorFocused) {
                        // Show toolbar above keyboard
                        showEditingUI()

                        // Position toolbar above keyboard, accounting for bottom inset
                        val layoutParams = keyboardToolbar.layoutParams as android.widget.RelativeLayout.LayoutParams
                        layoutParams.bottomMargin = ime.bottom
                        keyboardToolbar.layoutParams = layoutParams

                        // Notify web of keyboard height (including toolbar)
                        keyboardToolbar.post {
                            val toolbarHeightPx = keyboardToolbar.height
                            val totalHeightPx = ime.bottom + toolbarHeightPx
                            val totalHeightDp = (totalHeightPx / density).toInt()
                            webView.evaluateJavascript(
                                "window.postMessage({type: 'keyboard-show', height: $totalHeightDp}, '*');",
                                null
                            )
                        }
                    } else {
                        // Editor not focused, keyboard is for other input - hide toolbar only
                        // Don't clear webview focus as other inputs may need the keyboard
                        hideToolbarOnly()
                        
                        // Notify web about keyboard without toolbar height
                        webView.evaluateJavascript(
                            "window.postMessage({type: 'keyboard-show', height: 0}, '*');",
                            null
                        )
                    }
                } else {
                    // Keyboard closed - hide editing UI and clear focus
                    hideEditingUI()

                    webView.evaluateJavascript(
                        "window.postMessage({type: 'keyboard-hide'}, '*');",
                        null
                    )
                }
            }

            // Apply padding to loading screen (native Android view) to account for status bar
            // WebView content handles safe area insets via CSS custom properties
            loadingScreen.setPadding(0, topInset, 0, bottomInset)

            WindowInsetsCompat.CONSUMED
        }
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
    
    fun triggerHaptic(style: String) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val effect = when (style) {
                "light" -> VibrationEffect.createOneShot(10, VibrationEffect.DEFAULT_AMPLITUDE)
                "medium" -> VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE)
                "heavy" -> VibrationEffect.createOneShot(50, VibrationEffect.DEFAULT_AMPLITUDE)
                else -> VibrationEffect.createOneShot(10, VibrationEffect.DEFAULT_AMPLITUDE)
            }
            vibrator.vibrate(effect)
        } else {
            // Fallback for older Android versions
            @Suppress("DEPRECATION")
            val duration = when (style) {
                "light" -> 10L
                "medium" -> 20L
                "heavy" -> 50L
                else -> 10L
            }
            vibrator.vibrate(duration)
        }
    }
}
