package md.cypher.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Base64
import android.view.View
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.RelativeLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import java.io.File
import java.io.IOException

class MainActivity : BridgeActivity() {

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
    private lateinit var dividerButton: Button

    // Loading screen
    private lateinit var loadingScreen: View
    private lateinit var spinnerImage: ImageView

    // State tracking
    private var isBlockMenuOpen = false
    private var keyboardHeight = 0
    private var bottomInset = 0
    private var topInset = 0
    private var isEditorFocused = false
    private var hasPhysicalKeyboard = false
    private var isNightMode = false
    private var themeMode = "system"

    // Image picker
    private var currentPhotoUri: Uri? = null
    private lateinit var photoLibraryLauncher: ActivityResultLauncher<Intent>
    private lateinit var cameraLauncher: ActivityResultLauncher<Uri>
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        // Initialize activity result launchers before super.onCreate
        setupImagePickerLaunchers()

        super.onCreate(savedInstanceState)

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Initialize night mode state
        isNightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        // Add custom views to Capacitor's layout
        setupCustomViews()
        setupWindowInsets()
        setupToolbarListeners()
        setupBlockMenuListeners()
        detectPhysicalKeyboard()

        // Setup back navigation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (isBlockMenuOpen) {
                    closeBlockMenu()
                } else if (bridge.webView.canGoBack()) {
                    bridge.webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun load() {
        super.load()

        // Bridge is now initialized - add native bridge to WebView (internal name)
        bridge.webView.addJavascriptInterface(AndroidBridge(this, bridge.webView), "__NativeBridge")

        // Disable scrollbars - let web content handle scrolling
        bridge.webView.isVerticalScrollBarEnabled = false
        bridge.webView.isHorizontalScrollBarEnabled = false

        // Listen for page load to hide loading screen and inject bridge shim
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageLoaded(webView: WebView) {
                injectCypherBridgeShim()
                hideLoadingScreen()
                injectSafeAreaInsets()
                notifyPhysicalKeyboardState()
            }
        })
    }

    private fun setupCustomViews() {
        // Get Capacitor's root layout
        val rootLayout = findViewById<View>(android.R.id.content)
        val contentView = (rootLayout as? android.view.ViewGroup)?.getChildAt(0) as? android.view.ViewGroup
            ?: return

        // Wrap existing content in a RelativeLayout for overlay support
        val wrapper = RelativeLayout(this).apply {
            layoutParams = RelativeLayout.LayoutParams(
                RelativeLayout.LayoutParams.MATCH_PARENT,
                RelativeLayout.LayoutParams.MATCH_PARENT
            )
        }

        // Move existing views to wrapper
        val existingViews = mutableListOf<View>()
        for (i in 0 until contentView.childCount) {
            existingViews.add(contentView.getChildAt(i))
        }
        contentView.removeAllViews()
        for (view in existingViews) {
            wrapper.addView(view)
        }

        // Inflate and add block type menu
        blockTypeMenu = layoutInflater.inflate(R.layout.block_type_menu, wrapper, false)
        val blockMenuParams = RelativeLayout.LayoutParams(
            RelativeLayout.LayoutParams.MATCH_PARENT,
            RelativeLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            addRule(RelativeLayout.ALIGN_PARENT_BOTTOM)
        }
        blockTypeMenu.visibility = View.GONE
        wrapper.addView(blockTypeMenu, blockMenuParams)

        // Inflate and add keyboard toolbar
        keyboardToolbar = layoutInflater.inflate(R.layout.keyboard_toolbar, wrapper, false)
        val toolbarParams = RelativeLayout.LayoutParams(
            RelativeLayout.LayoutParams.MATCH_PARENT,
            RelativeLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            addRule(RelativeLayout.ALIGN_PARENT_BOTTOM)
        }
        keyboardToolbar.visibility = View.GONE
        wrapper.addView(keyboardToolbar, toolbarParams)

        // Add loading screen
        loadingScreen = layoutInflater.inflate(R.layout.loading_screen, wrapper, false)
        wrapper.addView(loadingScreen, RelativeLayout.LayoutParams(
            RelativeLayout.LayoutParams.MATCH_PARENT,
            RelativeLayout.LayoutParams.MATCH_PARENT
        ))

        contentView.addView(wrapper)

        // Initialize toolbar references
        undoButton = keyboardToolbar.findViewById(R.id.undoButton)
        redoButton = keyboardToolbar.findViewById(R.id.redoButton)
        inlineFormatButton = keyboardToolbar.findViewById(R.id.inlineFormatButton)
        blockTypeButton = keyboardToolbar.findViewById(R.id.blockTypeButton)
        dismissButton = keyboardToolbar.findViewById(R.id.dismissButton)

        toolbarScrollView = keyboardToolbar.findViewById(R.id.toolbarScrollView)
        formattingScrollView = keyboardToolbar.findViewById(R.id.formattingScrollView)
        boldButton = keyboardToolbar.findViewById(R.id.boldButton)
        italicButton = keyboardToolbar.findViewById(R.id.italicButton)
        codeButton = keyboardToolbar.findViewById(R.id.codeButton)
        strikethroughButton = keyboardToolbar.findViewById(R.id.strikethroughButton)
        closeFormattingButton = keyboardToolbar.findViewById(R.id.closeFormattingButton)

        // Initialize block type menu references
        heading1Button = blockTypeMenu.findViewById(R.id.heading1Button)
        heading2Button = blockTypeMenu.findViewById(R.id.heading2Button)
        heading3Button = blockTypeMenu.findViewById(R.id.heading3Button)
        paragraphButton = blockTypeMenu.findViewById(R.id.paragraphButton)
        numberedListButton = blockTypeMenu.findViewById(R.id.numberedListButton)
        taskListButton = blockTypeMenu.findViewById(R.id.taskListButton)
        bulletedListButton = blockTypeMenu.findViewById(R.id.bulletedListButton)
        imageButton = blockTypeMenu.findViewById(R.id.imageButton)
        dividerButton = blockTypeMenu.findViewById(R.id.dividerButton)

        // Initialize loading screen
        spinnerImage = loadingScreen.findViewById(R.id.spinnerImage)
        startSpinnerAnimation()
    }

    // ---- Image picker ----

    private fun setupImagePickerLaunchers() {
        photoLibraryLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                result.data?.data?.let { uri ->
                    handleSelectedImage(uri)
                }
            }
        }

        cameraLauncher = registerForActivityResult(
            ActivityResultContracts.TakePicture()
        ) { success ->
            if (success && currentPhotoUri != null) {
                handleSelectedImage(currentPhotoUri!!)
            }
        }

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
        when {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED -> {
                launchCameraInternal()
            }
            else -> {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }

    private fun launchCameraInternal() {
        try {
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
        } catch (_: IOException) {
            Toast.makeText(this, "Failed to open camera", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleSelectedImage(uri: Uri) {
        try {
            contentResolver.openInputStream(uri)?.use { inputStream ->
                val bytes = inputStream.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val mimeType = contentResolver.getType(uri) ?: "image/jpeg"
                val dataUrl = "data:$mimeType;base64,$base64"

                bridge.webView.post {
                    val escapedData = dataUrl.replace("'", "\\'")
                    bridge.webView.evaluateJavascript(
                        "window.postMessage({type: 'native-image-selected', dataUrl: '$escapedData'}, '*');",
                        null
                    )
                }
            }
        } catch (_: Exception) {
            Toast.makeText(this, "Failed to process image", Toast.LENGTH_SHORT).show()
        }
    }

    // ---- File sharing ----

    fun shareFileData(bytes: ByteArray, fileName: String, mimeType: String): Boolean {
        return try {
            val file = File(cacheDir, fileName)
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(this, "${applicationContext.packageName}.fileprovider", file)

            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            runOnUiThread {
                startActivity(Intent.createChooser(intent, null))
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    // ---- CypherBridge JS shim ----

    private fun injectCypherBridgeShim() {
        val shimScript = """
            (function() {
                if (window.CypherBridge) return;
                var nb = window.__NativeBridge;
                if (!nb) return;
                window.CypherBridge = {
                    clipboard: {
                        copy: function(t) { nb.copy(t); return Promise.resolve(); },
                        cut: function(t) { nb.cut(t); return Promise.resolve(); },
                        paste: function() { return Promise.resolve(nb.paste() || ''); }
                    },
                    haptic: {
                        trigger: function(s) { nb.haptic(s); return Promise.resolve(); }
                    },
                    editor: {
                        setFocused: function(f) { nb.setEditorFocused(f); return Promise.resolve(); },
                        updateUndoRedoState: function(u, r) { nb.updateUndoRedoState(u, r); return Promise.resolve(); },
                        updateToolbarIcon: function(t) { nb.updateToolbarIcon(t); return Promise.resolve(); },
                        updateFormattingState: function(b, i, c, s) { nb.updateFormattingState(b, i, c, s); return Promise.resolve(); },
                        setColorScheme: function(s) { nb.setColorScheme(s); return Promise.resolve(); }
                    },
                    navigation: {
                        openUrl: function(u) { nb.openUrl(u); return Promise.resolve(); },
                        openPhotoLibrary: function() { nb.openPhotoLibrary(); return Promise.resolve(); },
                        openCamera: function() { nb.openCamera(); return Promise.resolve(); }
                    },
                    files: {
                        shareFile: function(d, n, m) { return Promise.resolve(nb.shareFile(d, n, m)); }
                    },
                    storage: {
                        write: function(p, d) { return Promise.resolve(nb.storageWrite(p, d)); },
                        read: function(p) { return Promise.resolve(nb.storageRead(p)); },
                        delete: function(p) { return Promise.resolve(nb.storageDelete(p)); },
                        list: function(p) { var j = nb.storageList(p); return Promise.resolve(JSON.parse(j)); },
                        exists: function(p) { return Promise.resolve(nb.storageExists(p)); },
                        getInfo: function() { var j = nb.getStorageInfo(); return Promise.resolve(JSON.parse(j)); }
                    }
                };
            })();
        """.trimIndent()
        bridge.webView.evaluateJavascript(shimScript, null)
    }

    // ---- Toolbar listeners ----

    private fun setupToolbarListeners() {
        undoButton.setOnClickListener {
            bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.undo?.()", null)
        }

        redoButton.setOnClickListener {
            bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.redo?.()", null)
        }

        inlineFormatButton.setOnClickListener {
            toggleFormattingToolbar()
        }

        blockTypeButton.setOnClickListener {
            if (isBlockMenuOpen) {
                closeBlockMenu()
            } else {
                bridge.webView.evaluateJavascript(
                    "(function() { if(window.CypherEditorCallbacks && window.CypherEditorCallbacks.onFormatButtonClick) { return window.CypherEditorCallbacks.onFormatButtonClick(); } return false; })()",
                ) { result ->
                    if (result == "false") {
                        openBlockMenu()
                    }
                }
            }
        }

        boldButton.setOnClickListener {
            bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.toggleBold?.()", null)
        }

        italicButton.setOnClickListener {
            bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.toggleItalic?.()", null)
        }

        codeButton.setOnClickListener {
            bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.toggleCode?.()", null)
        }

        strikethroughButton.setOnClickListener {
            bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.toggleStrikethrough?.()", null)
        }

        closeFormattingButton.setOnClickListener {
            toggleFormattingToolbar()
        }

        dismissButton.setOnClickListener {
            if (isBlockMenuOpen) {
                closeBlockMenu()
            } else {
                hideKeyboard()
                hideEditingUI()
            }
        }
    }

    // ---- Block menu listeners ----

    private fun setupBlockMenuListeners() {
        heading1Button.setOnClickListener { setBlockType("heading1"); closeBlockMenu() }
        heading2Button.setOnClickListener { setBlockType("heading2"); closeBlockMenu() }
        heading3Button.setOnClickListener { setBlockType("heading3"); closeBlockMenu() }
        paragraphButton.setOnClickListener { setBlockType("paragraph"); closeBlockMenu() }
        numberedListButton.setOnClickListener { setBlockType("numbered_list"); closeBlockMenu() }
        taskListButton.setOnClickListener { setBlockType("todo_list"); closeBlockMenu() }
        bulletedListButton.setOnClickListener { setBlockType("bullet_list"); closeBlockMenu() }
        imageButton.setOnClickListener { setBlockType("image"); closeBlockMenu() }
        dividerButton.setOnClickListener { setBlockType("line"); closeBlockMenu() }
    }

    private fun setBlockType(type: String) {
        bridge.webView.evaluateJavascript("window.CypherEditorCallbacks?.setBlockType?.('$type')", null)
    }

    // ---- Block menu open/close ----

    private fun openBlockMenu() {
        isBlockMenuOpen = true
        dismissButton.setImageResource(R.drawable.ic_close)
        blockTypeButton.setColorFilter(getThemeColor(R.color.light_primary, R.color.dark_primary))
        hideKeyboard()

        val menuParams = blockTypeMenu.layoutParams as RelativeLayout.LayoutParams
        menuParams.height = keyboardHeight
        menuParams.bottomMargin = bottomInset
        blockTypeMenu.layoutParams = menuParams
        blockTypeMenu.visibility = View.VISIBLE

        val toolbarParams = keyboardToolbar.layoutParams as RelativeLayout.LayoutParams
        toolbarParams.bottomMargin = keyboardHeight + bottomInset
        keyboardToolbar.layoutParams = toolbarParams
    }

    private fun closeBlockMenu() {
        isBlockMenuOpen = false
        dismissButton.setImageResource(R.drawable.ic_keyboard_dismiss)
        blockTypeButton.clearColorFilter()

        val menuParams = blockTypeMenu.layoutParams as RelativeLayout.LayoutParams
        menuParams.bottomMargin = bottomInset
        blockTypeMenu.layoutParams = menuParams
        blockTypeMenu.visibility = View.GONE

        showKeyboard()
    }

    // ---- Formatting toolbar toggle ----

    private fun toggleFormattingToolbar() {
        isFormattingExpanded = !isFormattingExpanded
        val animDuration = 150L

        if (isFormattingExpanded) {
            toolbarScrollView.animate()
                .alpha(0f)
                .setDuration(animDuration)
                .withEndAction {
                    toolbarScrollView.visibility = View.GONE
                    formattingScrollView.alpha = 0f
                    formattingScrollView.visibility = View.VISIBLE
                    formattingScrollView.scrollTo(0, 0)
                    formattingScrollView.animate().alpha(1f).setDuration(animDuration).start()
                }
                .start()
        } else {
            formattingScrollView.animate()
                .alpha(0f)
                .setDuration(animDuration)
                .withEndAction {
                    formattingScrollView.visibility = View.GONE
                    toolbarScrollView.alpha = 0f
                    toolbarScrollView.visibility = View.VISIBLE
                    toolbarScrollView.scrollTo(0, 0)
                    toolbarScrollView.animate().alpha(1f).setDuration(animDuration).start()
                }
                .start()
        }
    }

    fun updateFormattingState(isBold: Boolean, isItalic: Boolean, isCode: Boolean, isStrikethrough: Boolean) {
        runOnUiThread {
            val activeColor = getThemeColor(R.color.light_primary, R.color.dark_primary)
            val inactiveColor = getThemeColor(R.color.light_foreground, R.color.dark_foreground)

            boldButton.setColorFilter(if (isBold) activeColor else inactiveColor)
            italicButton.setColorFilter(if (isItalic) activeColor else inactiveColor)
            codeButton.setColorFilter(if (isCode) activeColor else inactiveColor)
            strikethroughButton.setColorFilter(if (isStrikethrough) activeColor else inactiveColor)

            val anyFormatActive = isBold || isItalic || isCode || isStrikethrough
            inlineFormatButton.setColorFilter(if (anyFormatActive) activeColor else inactiveColor)
        }
    }

    // ---- Keyboard management ----

    private fun showKeyboard() {
        bridge.webView.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(bridge.webView, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(bridge.webView.windowToken, 0)
    }

    private fun hideToolbarOnly() {
        val toolbarParams = keyboardToolbar.layoutParams as RelativeLayout.LayoutParams
        toolbarParams.bottomMargin = bottomInset
        keyboardToolbar.layoutParams = toolbarParams
        keyboardToolbar.visibility = View.GONE

        if (isFormattingExpanded) {
            isFormattingExpanded = false
            toolbarScrollView.alpha = 1f
            toolbarScrollView.visibility = View.VISIBLE
            formattingScrollView.alpha = 0f
            formattingScrollView.visibility = View.GONE
        }

        if (isBlockMenuOpen) {
            dismissButton.setImageResource(R.drawable.ic_keyboard_dismiss)
            blockTypeButton.clearColorFilter()
            val menuParams = blockTypeMenu.layoutParams as RelativeLayout.LayoutParams
            menuParams.bottomMargin = bottomInset
            blockTypeMenu.layoutParams = menuParams
            blockTypeMenu.visibility = View.GONE
            isBlockMenuOpen = false
        }
    }

    private fun hideEditingUI() {
        hideToolbarOnly()
        bridge.webView.clearFocus()
    }

    private fun showEditingUI() {
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
                "none" -> blockTypeButton.visibility = View.GONE
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

    // ---- Safe area insets ----

    private fun injectSafeAreaInsets() {
        val density = resources.displayMetrics.density
        val topInsetDp = topInset / density
        val bottomInsetDp = bottomInset / density

        bridge.webView.evaluateJavascript("""
            (function() {
                if (document.documentElement) {
                    document.documentElement.style.setProperty('--safe-area-inset-top', '${topInsetDp}px');
                    document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottomInsetDp}px');
                    document.documentElement.style.setProperty('--safe-area-inset-left', '0px');
                    document.documentElement.style.setProperty('--safe-area-inset-right', '0px');
                }
            })();
        """.trimIndent(), null)
    }

    // ---- Window insets ----

    private fun setupWindowInsets() {
        val rootView = findViewById<View>(android.R.id.content)

        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, windowInsets ->
            val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())

            topInset = systemBars.top
            bottomInset = systemBars.bottom

            injectSafeAreaInsets()

            val density = resources.displayMetrics.density

            if (!isBlockMenuOpen) {
                val isKeyboardVisible = ime.bottom > bottomInset

                if (isKeyboardVisible) {
                    keyboardHeight = ime.bottom - bottomInset

                    val keyboardHeightDp = keyboardHeight / density
                    val isSoftKeyboard = keyboardHeightDp > 100

                    if (isSoftKeyboard != !hasPhysicalKeyboard) {
                        hasPhysicalKeyboard = !isSoftKeyboard
                        notifyPhysicalKeyboardState()
                    }

                    if (isEditorFocused && isSoftKeyboard) {
                        showEditingUI()

                        val layoutParams = keyboardToolbar.layoutParams as RelativeLayout.LayoutParams
                        layoutParams.bottomMargin = ime.bottom
                        keyboardToolbar.layoutParams = layoutParams

                        keyboardToolbar.post {
                            val toolbarHeightPx = keyboardToolbar.height
                            val totalHeightPx = ime.bottom + toolbarHeightPx
                            val totalHeightDp = (totalHeightPx / density).toInt()
                            bridge.webView.evaluateJavascript(
                                "window.postMessage({type: 'keyboard-show', height: $totalHeightDp}, '*');",
                                null
                            )
                        }
                    } else {
                        hideToolbarOnly()
                        bridge.webView.evaluateJavascript(
                            "window.postMessage({type: 'keyboard-show', height: 0}, '*');",
                            null
                        )
                    }
                } else {
                    hideEditingUI()
                    bridge.webView.evaluateJavascript(
                        "window.postMessage({type: 'keyboard-hide'}, '*');",
                        null
                    )
                }
            }

            loadingScreen.setPadding(0, topInset, 0, bottomInset)

            WindowInsetsCompat.CONSUMED
        }
    }

    // ---- Loading screen ----

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

    // ---- Haptic feedback ----

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
            @Suppress("DEPRECATION")
            val duration = when (style) {
                "light" -> 10L
                "medium" -> 20L
                "heavy" -> 50L
                else -> 10L
            }
            @Suppress("DEPRECATION")
            vibrator.vibrate(duration)
        }
    }

    // ---- Physical keyboard detection ----

    private fun detectPhysicalKeyboard() {
        val config = resources.configuration
        val previousState = hasPhysicalKeyboard

        if (config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_YES ||
            config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_UNDEFINED) {
            hasPhysicalKeyboard = false
        }

        if (previousState != hasPhysicalKeyboard) {
            notifyPhysicalKeyboardState()
            if (hasPhysicalKeyboard && isEditorFocused) {
                hideToolbarOnly()
            }
        }
    }

    private fun notifyPhysicalKeyboardState() {
        bridge.webView.evaluateJavascript(
            "window.postMessage({type: 'physical-keyboard-connected', connected: $hasPhysicalKeyboard}, '*');",
            null
        )
    }

    // ---- Configuration changes ----

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        detectPhysicalKeyboard()

        if (themeMode == "system") {
            val newNightMode = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            if (newNightMode != isNightMode) {
                isNightMode = newNightMode
                updateToolbarColors()
                updateBlockMenuColors()
                loadingScreen.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
                updateSystemBarsAppearance(isNightMode)
            }
        }
    }

    // ---- Theme management ----

    fun onWebThemeChanged(theme: String) {
        runOnUiThread {
            themeMode = theme
            isNightMode = when (theme) {
                "dark" -> true
                "light" -> false
                "system" -> {
                    val currentNightMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
                    currentNightMode == Configuration.UI_MODE_NIGHT_YES
                }
                else -> false
            }
            updateToolbarColors()
            updateBlockMenuColors()
            loadingScreen.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
            updateSystemBarsAppearance(isNightMode)
        }
    }

    fun onWebColorSchemeChanged(colorScheme: String) {
        runOnUiThread {
            isNightMode = colorScheme == "dark"
            updateToolbarColors()
            updateBlockMenuColors()
            loadingScreen.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))
            updateSystemBarsAppearance(isNightMode)
        }
    }

    private fun updateSystemBarsAppearance(isDark: Boolean) {
        val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
        windowInsetsController.isAppearanceLightStatusBars = !isDark
        windowInsetsController.isAppearanceLightNavigationBars = !isDark
    }

    private fun getThemeColor(lightColorRes: Int, darkColorRes: Int): Int {
        return getColor(if (isNightMode) darkColorRes else lightColorRes)
    }

    private fun updateToolbarColors() {
        keyboardToolbar.setBackgroundColor(getThemeColor(R.color.light_background, R.color.dark_background))

        val toolbarInner = keyboardToolbar.findViewById<View>(R.id.toolbarInner)
        (toolbarInner?.background as? GradientDrawable)?.setColor(
            getThemeColor(R.color.light_muted, R.color.dark_muted)
        )

        val foregroundColor = getThemeColor(R.color.light_foreground, R.color.dark_foreground)
        undoButton.setColorFilter(foregroundColor)
        redoButton.setColorFilter(foregroundColor)
        inlineFormatButton.setColorFilter(foregroundColor)
        if (!isBlockMenuOpen) {
            blockTypeButton.setColorFilter(foregroundColor)
        }
        dismissButton.setColorFilter(foregroundColor)

        boldButton.setColorFilter(foregroundColor)
        italicButton.setColorFilter(foregroundColor)
        codeButton.setColorFilter(foregroundColor)
        strikethroughButton.setColorFilter(foregroundColor)
        closeFormattingButton.setColorFilter(foregroundColor)

        val divider = keyboardToolbar.findViewById<View>(R.id.toolbarDivider)
        divider?.setBackgroundColor(getThemeColor(R.color.light_border, R.color.dark_border))
    }

    private fun updateBlockMenuColors() {
        blockTypeMenu.setBackgroundColor(getThemeColor(R.color.light_card, R.color.dark_card))

        val headerText = blockTypeMenu.findViewById<TextView>(R.id.blockMenuHeader)
        headerText?.setTextColor(getThemeColor(R.color.light_foreground, R.color.dark_foreground))

        val buttonIds = listOf(
            R.id.heading1Button, R.id.heading2Button, R.id.heading3Button,
            R.id.paragraphButton, R.id.numberedListButton, R.id.taskListButton,
            R.id.bulletedListButton, R.id.imageButton, R.id.dividerButton
        )
        val foregroundColor = getThemeColor(R.color.light_foreground, R.color.dark_foreground)
        val mutedColor = getThemeColor(R.color.light_muted, R.color.dark_muted)

        for (buttonId in buttonIds) {
            val button = blockTypeMenu.findViewById<Button>(buttonId)
            button?.setTextColor(foregroundColor)
            (button?.background as? GradientDrawable)?.setColor(mutedColor)
        }
    }
}
