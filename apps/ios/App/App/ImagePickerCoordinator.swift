import UIKit
import WebKit

class ImagePickerCoordinator: NSObject, UINavigationControllerDelegate,
    UIImagePickerControllerDelegate
{
    weak var webView: WKWebView?
    weak var presentingViewController: UIViewController?

    func openPhotoLibrary() {
        DispatchQueue.main.async {
            self.presentImagePicker(sourceType: .photoLibrary)
        }
    }

    func openCamera() {
        DispatchQueue.main.async {
            guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                return
            }
            self.presentImagePicker(sourceType: .camera)
        }
    }

    private func presentImagePicker(sourceType: UIImagePickerController.SourceType) {
        guard let presenter = presentingViewController else {
            return
        }

        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = self
        picker.allowsEditing = false

        presenter.present(picker, animated: true)
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)

        guard let image = info[.originalImage] as? UIImage else {
            return
        }

        // Convert image to JPEG data
        guard let imageData = image.jpegData(compressionQuality: 0.8) else {
            return
        }

        // Convert to base64
        let base64String = imageData.base64EncodedString()
        let dataUrl = "data:image/jpeg;base64,\(base64String)"

        // Send to web view
        let escapedData = dataUrl.replacingOccurrences(of: "'", with: "\\'")
        let javascript = """
            window.postMessage({type: 'native-image-selected', dataUrl: '\(escapedData)'}, '*');
            """

        webView?.evaluateJavaScript(javascript, completionHandler: nil)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
    }
}
