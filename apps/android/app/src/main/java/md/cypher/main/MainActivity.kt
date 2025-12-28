package md.cypher.main

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.animation.Animation
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity

class MainActivity : ComponentActivity() {
    
    private lateinit var webView: WebView
    private lateinit var loadingScreen: View
    private lateinit var spinnerImage: ImageView
    
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        // Initialize views
        webView = findViewById(R.id.webView)
        loadingScreen = findViewById(R.id.loadingScreen)
        spinnerImage = findViewById(R.id.spinnerImage)
        
        // Start spinner animation
        startSpinnerAnimation()
        
        // Configure WebView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
        }
        
        // Set WebViewClient to handle page loading
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // Hide loading screen when page is loaded
                hideLoadingScreen()
            }
            
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false
            }
        }
        
        // Handle back button press
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
        
        // Load the URL
        webView.loadUrl("http://192.168.68.50:5173/")
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

