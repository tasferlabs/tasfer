package md.cypher.main

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Toast
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import androidx.core.graphics.Insets
import java.io.File
import java.io.IOException

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
    
    @JavascriptInterface
    fun openPhotoLibrary() {
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.launchPhotoLibrary()
        }
    }
    
    @JavascriptInterface
    fun openCamera() {
        (context as? MainActivity)?.runOnUiThread {
            (context as? MainActivity)?.launchCamera()
        }
    }
    
    @JavascriptInterface
    fun updateToolbarIcon(iconType: String) {
        (context as? MainActivity)?.updateToolbarIcon(iconType)
    }

    @JavascriptInterface
    fun updateFormattingState(isBold: Boolean, isItalic: Boolean, isCode: Boolean, isStrikethrough: Boolean) {
        (context as? MainActivity)?.updateFormattingState(isBold, isItalic, isCode, isStrikethrough)
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
    private lateinit var inlineFormatButton: ImageButton
    private lateinit var blockTypeButton: ImageButton
    private lateinit var dismissButton: ImageButton

    // Formatting toolbar elements
    private lateinit var toolbarScrollView: HorizontalScrollView
    private lateinit var formattingScrollView: HorizontalScrollView
    private lateinit var boldButton: ImageButton
    private lateinit var italicButton: ImageButton
    private lateinit var codeButton: ImageButton
    private lateinit var strikethroughButton: ImageButton
    private lateinit var closeFormattingButton: ImageButton
    private var isFormattingExpanded = false

    // Block type menu elements
    private lateinit var blockTypeMenu: View
    private lateinit var heading1Button: Button
    private lateinit var heading2Button: Button
    private lateinit var heading3Button: Button
    private lateinit var paragraphButton: Button
    private lateinit var numberedListButton: Button
    private lateinit var taskListButton: Button
    private lateinit var bulletedListButton: Button
    private lateinit var imageButton: Button
    
    // State tracking
    private var isBlockMenuOpen = false
    private var keyboardHeight = 0
    private var bottomInset = 0
    private var topInset = 0
    private var isEditorFocused = false  // Track if canvas editor is focused
    private var hasPhysicalKeyboard = false  // Track hardware keyboard status
    
    // Image picker
    private var currentPhotoUri: Uri? = null
    private lateinit var photoLibraryLauncher: ActivityResultLauncher<Intent>
    private lateinit var cameraLauncher: ActivityResultLauncher<Uri>
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>
    
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Initialize activity result launchers before onCreate
        setupImagePickerLaunchers()
        
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
        inlineFormatButton = keyboardToolbar.findViewById(R.id.inlineFormatButton)
        blockTypeButton = keyboardToolbar.findViewById(R.id.blockTypeButton)
        dismissButton = keyboardToolbar.findViewById(R.id.dismissButton)

        // Initialize formatting toolbar
        toolbarScrollView = keyboardToolbar.findViewById(R.id.toolbarScrollView)
        formattingScrollView = keyboardToolbar.findViewById(R.id.formattingScrollView)
        boldButton = keyboardToolbar.findViewById(R.id.boldButton)
        italicButton = keyboardToolbar.findViewById(R.id.italicButton)
        codeButton = keyboardToolbar.findViewById(R.id.codeButton)
        strikethroughButton = keyboardToolbar.findViewById(R.id.strikethroughButton)
        closeFormattingButton = keyboardToolbar.findViewById(R.id.closeFormattingButton)

        // Initialize block type menu
        blockTypeMenu = findViewById(R.id.blockTypeMenu)
        heading1Button = blockTypeMenu.findViewById(R.id.heading1Button)
        heading2Button = blockTypeMenu.findViewById(R.id.heading2Button)
        heading3Button = blockTypeMenu.findViewById(R.id.heading3Button)
        paragraphButton = blockTypeMenu.findViewById(R.id.paragraphButton)
        numberedListButton = blockTypeMenu.findViewById(R.id.numberedListButton)
        taskListButton = blockTypeMenu.findViewById(R.id.taskListButton)
        bulletedListButton = blockTypeMenu.findViewById(R.id.bulletedListButton)
        imageButton = blockTypeMenu.findViewById(R.id.imageButton)
        
        startSpinnerAnimation()
        setupWindowInsets()
        setupToolbarListeners()
        setupBlockMenuListeners()
        detectPhysicalKeyboard()
        
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
                // Send initial physical keyboard state
                notifyPhysicalKeyboardState()
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
    
    private fun setupImagePickerLaunchers() {
        // Photo library launcher
        photoLibraryLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                result.data?.data?.let { uri ->
                    handleSelectedImage(uri)
                }
            }
        }
        
        // Camera launcher
        cameraLauncher = registerForActivityResult(
            ActivityResultContracts.TakePicture()
        ) { success ->
            if (success && currentPhotoUri != null) {
                handleSelectedImage(currentPhotoUri!!)
            }
        }
        
        // Camera permission launcher
        cameraPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { isGranted ->
            if (isGranted) {
                launchCameraInternal()
            } else {
                Toast.makeText(this, "Camera permission is required to take photos", Toast.LENGTH_SHORT).show()
            }
        }
    }
    
    fun launchPhotoLibrary() {
        val intent = Intent(Intent.ACTION_PICK).apply {
            type = "image/*"
        }
        photoLibraryLauncher.launch(intent)
    }
    
    fun launchCamera() {
        // Check if camera permission is granted
        when {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED -> {
                // Permission already granted
                launchCameraInternal()
            }
            else -> {
                // Request permission
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }
    
    private fun launchCameraInternal() {
        try {
            // Create a file to store the photo
            val photoFile = File.createTempFile(
                "JPEG_${System.currentTimeMillis()}_",
                ".jpg",
                cacheDir
            )
            
            currentPhotoUri = FileProvider.getUriForFile(
                this,
                "${applicationContext.packageName}.fileprovider",
                photoFile
            )
            
            cameraLauncher.launch(currentPhotoUri!!)
        } catch (e: IOException) {
            Toast.makeText(this, "Failed to open camera", Toast.LENGTH_SHORT).show()
        }
    }
    
    private fun handleSelectedImage(uri: Uri) {
        try {
            // Read the image file and convert to base64
            contentResolver.openInputStream(uri)?.use { inputStream ->
                val bytes = inputStream.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                
                // Determine MIME type
                val mimeType = contentResolver.getType(uri) ?: "image/jpeg"
                val dataUrl = "data:$mimeType;base64,$base64"
                
                // Send the image data to the web view
                webView.post {
                    val escapedData = dataUrl.replace("'", "\\'")
                    val javascript = "window.postMessage({type: 'native-image-selected', dataUrl: '$escapedData'}, '*');"
                    webView.evaluateJavascript(javascript, null)
                }
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Failed to process image", Toast.LENGTH_SHORT).show()
        }
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

        // Inline format button - toggles formatting toolbar
        inlineFormatButton.setOnClickListener {
            toggleFormattingToolbar()
        }

        // Block type button - opens block type menu or triggers native drawer
        blockTypeButton.setOnClickListener {
            if (isBlockMenuOpen) {
                // In block menu mode: return to keyboard
                closeBlockMenu()
            } else {
                // Check if we should open a native drawer instead
                webView.evaluateJavascript(
                    "(function() { if(window.AndroidBridge && window.AndroidBridge.onFormatButtonClick) { return window.AndroidBridge.onFormatButtonClick(); } return false; })()",
                    { result ->
                        // If web didn't handle it (returns false), open block menu
                        if (result == "false") {
                            openBlockMenu()
                        }
                    }
                )
            }
        }

        // Formatting buttons
        boldButton.setOnClickListener {
            webView.evaluateJavascript("window.AndroidBridge?.toggleBold?.()", null)
        }

        italicButton.setOnClickListener {
            webView.evaluateJavascript("window.AndroidBridge?.toggleItalic?.()", null)
        }

        codeButton.setOnClickListener {
            webView.evaluateJavascript("window.AndroidBridge?.toggleCode?.()", null)
        }

        strikethroughButton.setOnClickListener {
            webView.evaluateJavascript("window.AndroidBridge?.toggleStrikethrough?.()", null)
        }

        closeFormattingButton.setOnClickListener {
            toggleFormattingToolbar()
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
        
        numberedListButton.setOnClickListener {
            setBlockType("numbered_list")
            closeBlockMenu()
        }
        
        taskListButton.setOnClickListener {
            setBlockType("todo_list")
            closeBlockMenu()
        }
        
        bulletedListButton.setOnClickListener {
            setBlockType("bullet_list")
            closeBlockMenu()
        }
        
        imageButton.setOnClickListener {
            setBlockType("image")
            closeBlockMenu()
        }
    }
    
    private fun setBlockType(type: String) {
        webView.evaluateJavascript("window.AndroidBridge?.setBlockType?.('$type')", null)
    }
    
    private fun openBlockMenu() {
        isBlockMenuOpen = true

        // Update dismiss button icon to X (close icon)
        dismissButton.setImageResource(R.drawable.ic_close)

        // Highlight block type button with primary color
        blockTypeButton.setColorFilter(getColor(R.color.primary))

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

        // Update dismiss button icon back to keyboard dismiss
        dismissButton.setImageResource(R.drawable.ic_keyboard_dismiss)

        // Reset block type button color to default (label color)
        blockTypeButton.clearColorFilter()

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

    private fun toggleFormattingToolbar() {
        isFormattingExpanded = !isFormattingExpanded
        val animDuration = 150L

        if (isFormattingExpanded) {
            // Fade out main toolbar first, then show formatting toolbar
            toolbarScrollView.animate()
                .alpha(0f)
                .setDuration(animDuration)
                .withEndAction {
                    toolbarScrollView.visibility = View.GONE

                    // Now show and fade in formatting toolbar
                    formattingScrollView.alpha = 0f
                    formattingScrollView.visibility = View.VISIBLE
                    formattingScrollView.scrollTo(0, 0)

                    formattingScrollView.animate()
                        .alpha(1f)
                        .setDuration(animDuration)
                        .start()
                }
                .start()
        } else {
            // Fade out formatting toolbar first, then show main toolbar
            formattingScrollView.animate()
                .alpha(0f)
                .setDuration(animDuration)
                .withEndAction {
                    formattingScrollView.visibility = View.GONE

                    // Now show and fade in main toolbar
                    toolbarScrollView.alpha = 0f
                    toolbarScrollView.visibility = View.VISIBLE
                    toolbarScrollView.scrollTo(0, 0)

                    toolbarScrollView.animate()
                        .alpha(1f)
                        .setDuration(animDuration)
                        .start()
                }
                .start()
        }
    }

    fun updateFormattingState(isBold: Boolean, isItalic: Boolean, isCode: Boolean, isStrikethrough: Boolean) {
        runOnUiThread {
            val activeColor = getColor(R.color.primary)
            val inactiveColor = getColor(R.color.foreground)

            boldButton.setColorFilter(if (isBold) activeColor else inactiveColor)
            italicButton.setColorFilter(if (isItalic) activeColor else inactiveColor)
            codeButton.setColorFilter(if (isCode) activeColor else inactiveColor)
            strikethroughButton.setColorFilter(if (isStrikethrough) activeColor else inactiveColor)

            // Update inline format button to show active if any format is active
            val anyFormatActive = isBold || isItalic || isCode || isStrikethrough
            inlineFormatButton.setColorFilter(if (anyFormatActive) activeColor else inactiveColor)
        }
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

        // Collapse formatting toolbar if expanded
        if (isFormattingExpanded) {
            isFormattingExpanded = false
            // Reset alpha values and visibility without animation
            toolbarScrollView.alpha = 1f
            toolbarScrollView.visibility = View.VISIBLE
            formattingScrollView.alpha = 0f
            formattingScrollView.visibility = View.GONE
        }

        // Hide block menu if open
        if (isBlockMenuOpen) {
            // Reset dismiss button icon back to keyboard dismiss
            dismissButton.setImageResource(R.drawable.ic_keyboard_dismiss)

            // Reset format button color to default
            blockTypeButton.clearColorFilter()

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
    
    fun updateToolbarIcon(iconType: String) {
        runOnUiThread {
            when (iconType) {
                "none" -> {
                    // Hide block type button when no icon should be shown
                    blockTypeButton.visibility = View.GONE
                }
                "link" -> {
                    blockTypeButton.visibility = View.VISIBLE
                    blockTypeButton.setImageResource(R.drawable.ic_link)
                }
                "image" -> {
                    blockTypeButton.visibility = View.VISIBLE
                    blockTypeButton.setImageResource(R.drawable.ic_image)
                }
                else -> {
                    blockTypeButton.visibility = View.VISIBLE
                    blockTypeButton.setImageResource(R.drawable.ic_paragraph)
                }
            }
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
                    
                    // Detect if this is a soft keyboard or hardware keyboard based on IME height
                    // Hardware keyboards show with minimal IME insets (0-100dp), soft keyboards are taller (200+dp)
                    val keyboardHeightDp = keyboardHeight / density
                    val isSoftKeyboard = keyboardHeightDp > 100
                    
                    // Update physical keyboard state based on actual keyboard appearance
                    if (isSoftKeyboard != !hasPhysicalKeyboard) {
                        hasPhysicalKeyboard = !isSoftKeyboard
                        notifyPhysicalKeyboardState()
                    }

                    // Only show toolbar if canvas editor is focused AND soft keyboard is showing
                    if (isEditorFocused && isSoftKeyboard) {
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
                        // Editor not focused or hardware keyboard - hide toolbar only
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
    
    private fun detectPhysicalKeyboard() {
        // Initial detection - default to no physical keyboard
        // The actual state is determined by IME inset height in setupWindowInsets
        // when the keyboard actually appears
        // 
        // On Android tablets, hardKeyboardHidden can be unreliable because a Bluetooth
        // keyboard might be paired but the user can still choose to show the soft keyboard
        val config = resources.configuration
        val previousState = hasPhysicalKeyboard
        
        // Only update to false if definitely no keyboard, otherwise let IME insets decide
        if (config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_YES ||
            config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_UNDEFINED) {
            hasPhysicalKeyboard = false
        }
        
        // Notify web view if state changed
        if (previousState != hasPhysicalKeyboard) {
            notifyPhysicalKeyboardState()
            
            // Hide toolbar when physical keyboard is connected
            if (hasPhysicalKeyboard && isEditorFocused) {
                hideToolbarOnly()
            }
        }
    }
    
    private fun notifyPhysicalKeyboardState() {
        webView.evaluateJavascript(
            "window.postMessage({type: 'physical-keyboard-connected', connected: $hasPhysicalKeyboard}, '*');",
            null
        )
    }
    
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Re-detect physical keyboard when configuration changes
        // This catches keyboard connect/disconnect events
        detectPhysicalKeyboard()
    }
}
