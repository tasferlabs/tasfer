# Speech-to-Text Implementation Options

## 1. Web Speech API (Web)
- **Platform**: Web only
- **Cost**: Free
- **Offline**: No
- **Accuracy**: Good
- **Real-time**: Yes
- **Notes**: Native browser API, limited browser support (no Firefox)

```typescript
const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.continuous = true;
recognition.interimResults = true;
recognition.onresult = (event) => {
  const transcript = event.results[event.results.length - 1][0].transcript;
};
recognition.start();
```

## 2. Android SpeechRecognizer (Android)
- **Platform**: Android
- **Cost**: Free
- **Offline**: Yes (with models)
- **Accuracy**: Good
- **Real-time**: Yes with partial results
- **Notes**: Requires RECORD_AUDIO permission

```kotlin
val speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context)
val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
speechRecognizer.startListening(intent)
```

## 3. iOS Speech Framework (iOS)
- **Platform**: iOS
- **Cost**: Free
- **Offline**: Yes (device models)
- **Accuracy**: Excellent
- **Real-time**: Yes
- **Notes**: 1 min/request limit, 1000 requests/day, requires permission

```swift
import Speech
let recognizer = SFSpeechRecognizer()
let request = SFSpeechAudioBufferRecognitionRequest()
recognizer?.recognitionTask(with: request) { result, error in
  let transcript = result?.bestTranscription.formattedString
}
```

## 4. OpenAI Whisper API (All platforms)
- **Platform**: All (API)
- **Cost**: $0.006/minute
- **Offline**: No
- **Accuracy**: Excellent
- **Real-time**: No (file-based)
- **Notes**: 98+ languages, requires API key

```typescript
const formData = new FormData();
formData.append('file', audioBlob);
formData.append('model', 'whisper-1');
fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${API_KEY}` },
  body: formData
});
```

## 5. Whisper.cpp (Self-hosted)
- **Platform**: All (server/local)
- **Cost**: Free (open-source)
- **Offline**: Yes
- **Accuracy**: Excellent
- **Real-time**: No (processing time needed)
- **Notes**: 75MB-1.5GB models, CPU intensive

## 6. Google Cloud Speech-to-Text (All platforms)
- **Platform**: All (API)
- **Cost**: 60min free/month, then $0.006/15sec
- **Offline**: No
- **Accuracy**: Excellent
- **Real-time**: Yes (streaming)
- **Notes**: 125+ languages

## 7. Azure Speech Services (All platforms)
- **Platform**: All (API)
- **Cost**: 5 hours free/month, then tiered
- **Offline**: No
- **Accuracy**: Excellent
- **Real-time**: Yes (streaming)
- **Notes**: JavaScript SDK available

## Recommended Approach

**Use native APIs first** (free, real-time, works offline):
- Web → Web Speech API
- Android → SpeechRecognizer
- iOS → Speech Framework

**Fallback/Premium option**:
- Whisper API for better accuracy and more languages

