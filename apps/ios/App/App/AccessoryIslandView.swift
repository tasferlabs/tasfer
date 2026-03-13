import UIKit

class AccessoryIslandView: UIView {
    var onUndo: (() -> Void)?
    var onRedo: (() -> Void)?
    var onFormat: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onBlockType: (() -> Void)?
    var onBold: (() -> Void)?
    var onItalic: (() -> Void)?
    var onCode: (() -> Void)?
    var onStrikethrough: (() -> Void)?

    // Main toolbar buttons
    private let undoBtn = UIButton(type: .system)
    private let redoBtn = UIButton(type: .system)
    private let inlineFormatBtn = UIButton(type: .system)
    private let blockTypeBtn = UIButton(type: .system)
    private let dismissBtn = UIButton(type: .system)

    // Formatting buttons
    private let boldBtn = UIButton(type: .system)
    private let italicBtn = UIButton(type: .system)
    private let codeBtn = UIButton(type: .system)
    private let strikethroughBtn = UIButton(type: .system)
    private let closeFormatBtn = UIButton(type: .system)

    // Container views
    private var container: UIView!
    private var scrollView: UIScrollView!
    private var mainButtonsStack: UIStackView!
    private var formattingButtonsStack: UIStackView!
    private var dividerView: UIView!

    // Constraints for safe area adjustment (Dynamic Island support)
    private var containerLeadingConstraint: NSLayoutConstraint?
    private var containerTrailingConstraint: NSLayoutConstraint?

    private var isFormattingExpanded = false

    var currentIconType: String = "format"

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let leadingInset = max(safeAreaInsets.left, 8)
        let trailingInset = max(safeAreaInsets.right, 8)
        containerLeadingConstraint?.constant = leadingInset
        containerTrailingConstraint?.constant = -trailingInset
    }

    private func setupUI() {
        backgroundColor = .clear
        autoresizingMask = [.flexibleWidth, .flexibleHeight]

        container = UIView()
        container.backgroundColor = .secondarySystemGroupedBackground
        container.layer.cornerRadius = 22
        container.layer.shadowColor = UIColor.black.cgColor
        container.layer.shadowOpacity = 0.1
        container.layer.shadowOffset = CGSize(width: 0, height: 4)
        container.layer.shadowRadius = 8
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)

        scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.alwaysBounceHorizontal = true
        container.addSubview(scrollView)

        mainButtonsStack = UIStackView(arrangedSubviews: [
            undoBtn, redoBtn, inlineFormatBtn, blockTypeBtn,
        ])
        mainButtonsStack.axis = .horizontal
        mainButtonsStack.distribution = .fill
        mainButtonsStack.alignment = .center
        mainButtonsStack.spacing = 2
        mainButtonsStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(mainButtonsStack)

        formattingButtonsStack = UIStackView(arrangedSubviews: [
            closeFormatBtn, boldBtn, italicBtn, codeBtn, strikethroughBtn,
        ])
        formattingButtonsStack.axis = .horizontal
        formattingButtonsStack.distribution = .fill
        formattingButtonsStack.alignment = .center
        formattingButtonsStack.spacing = 2
        formattingButtonsStack.translatesAutoresizingMaskIntoConstraints = false
        formattingButtonsStack.isHidden = true
        scrollView.addSubview(formattingButtonsStack)

        dividerView = UIView()
        dividerView.backgroundColor = .separator
        dividerView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dividerView)

        dismissBtn.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(dismissBtn)

        let buttonWidth: CGFloat = 44
        let buttonHeight: CGFloat = 44

        for button in [
            undoBtn, redoBtn, inlineFormatBtn, blockTypeBtn, dismissBtn, boldBtn, italicBtn,
            codeBtn, strikethroughBtn, closeFormatBtn,
        ] {
            NSLayoutConstraint.activate([
                button.widthAnchor.constraint(equalToConstant: buttonWidth),
                button.heightAnchor.constraint(equalToConstant: buttonHeight),
            ])
        }

        containerLeadingConstraint = container.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8)
        containerTrailingConstraint = container.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8)

        NSLayoutConstraint.activate([
            containerLeadingConstraint!,
            containerTrailingConstraint!,
            container.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            container.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            container.heightAnchor.constraint(equalToConstant: 44),

            dismissBtn.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -4),
            dismissBtn.centerYAnchor.constraint(equalTo: container.centerYAnchor),

            dividerView.trailingAnchor.constraint(equalTo: dismissBtn.leadingAnchor, constant: -4),
            dividerView.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            dividerView.widthAnchor.constraint(equalToConstant: 1),
            dividerView.heightAnchor.constraint(equalToConstant: 28),

            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 4),
            scrollView.trailingAnchor.constraint(equalTo: dividerView.leadingAnchor, constant: -4),
            scrollView.topAnchor.constraint(equalTo: container.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            mainButtonsStack.leadingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            mainButtonsStack.trailingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            mainButtonsStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            mainButtonsStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            mainButtonsStack.heightAnchor.constraint(
                equalTo: scrollView.frameLayoutGuide.heightAnchor),

            formattingButtonsStack.leadingAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            formattingButtonsStack.topAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.topAnchor),
            formattingButtonsStack.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            formattingButtonsStack.heightAnchor.constraint(
                equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])

        // Setup buttons with custom icons
        configureButtonWithImage(undoBtn, imageName: "undo")
        configureButtonWithImage(redoBtn, imageName: "redo")
        configureButtonWithImage(inlineFormatBtn, imageName: "format_text")
        configureButtonWithImage(blockTypeBtn, imageName: "paragraph")
        configureButtonWithImage(dismissBtn, imageName: "keyboard_dismiss")

        configureButtonWithImage(boldBtn, imageName: "bold")
        configureButtonWithImage(italicBtn, imageName: "italic")
        configureButtonWithImage(codeBtn, imageName: "code")
        configureButtonWithImage(strikethroughBtn, imageName: "strikethrough")

        let closeConfig = UIImage.SymbolConfiguration(scale: .medium)
        closeFormatBtn.setImage(
            UIImage(systemName: "chevron.left", withConfiguration: closeConfig), for: .normal)
        closeFormatBtn.tintColor = .label

        undoBtn.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        redoBtn.addTarget(self, action: #selector(redoTapped), for: .touchUpInside)
        inlineFormatBtn.addTarget(self, action: #selector(inlineFormatTapped), for: .touchUpInside)
        blockTypeBtn.addTarget(self, action: #selector(blockTypeTapped), for: .touchUpInside)
        dismissBtn.addTarget(self, action: #selector(dismissTapped), for: .touchUpInside)

        boldBtn.addTarget(self, action: #selector(boldTapped), for: .touchUpInside)
        italicBtn.addTarget(self, action: #selector(italicTapped), for: .touchUpInside)
        codeBtn.addTarget(self, action: #selector(codeTapped), for: .touchUpInside)
        strikethroughBtn.addTarget(
            self, action: #selector(strikethroughTapped), for: .touchUpInside)
        closeFormatBtn.addTarget(self, action: #selector(closeFormatTapped), for: .touchUpInside)
    }

    private func configureButtonWithImage(_ button: UIButton, imageName: String) {
        if let image = UIImage(named: imageName) {
            button.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
        button.tintColor = .label
    }

    func toggleFormattingExpansion() {
        isFormattingExpanded.toggle()

        if isFormattingExpanded {
            formattingButtonsStack.alpha = 0
            formattingButtonsStack.isHidden = false

            UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseInOut) {
                self.mainButtonsStack.alpha = 0
                self.formattingButtonsStack.alpha = 1
            } completion: { _ in
                self.mainButtonsStack.isHidden = true
            }
        } else {
            mainButtonsStack.alpha = 0
            mainButtonsStack.isHidden = false

            UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseInOut) {
                self.formattingButtonsStack.alpha = 0
                self.mainButtonsStack.alpha = 1
            } completion: { _ in
                self.formattingButtonsStack.isHidden = true
            }
        }

        scrollView.setContentOffset(.zero, animated: true)
    }

    @objc private func undoTapped() { onUndo?() }
    @objc private func redoTapped() { onRedo?() }
    @objc private func inlineFormatTapped() { toggleFormattingExpansion() }
    @objc private func blockTypeTapped() { onBlockType?() }
    @objc private func dismissTapped() { onDismiss?() }

    @objc private func boldTapped() { onBold?() }
    @objc private func italicTapped() { onItalic?() }
    @objc private func codeTapped() { onCode?() }
    @objc private func strikethroughTapped() { onStrikethrough?() }
    @objc private func closeFormatTapped() { toggleFormattingExpansion() }

    func updateState(canUndo: Bool, canRedo: Bool, isMenuOpen: Bool) {
        undoBtn.isEnabled = canUndo
        redoBtn.isEnabled = canRedo
        undoBtn.alpha = canUndo ? 1.0 : 0.3
        redoBtn.alpha = canRedo ? 1.0 : 0.3

        blockTypeBtn.tintColor = isMenuOpen ? .systemGreen : .label

        let dismissImageName = isMenuOpen ? "xmark" : "keyboard_dismiss"
        if dismissImageName == "xmark" {
            let config = UIImage.SymbolConfiguration(scale: .medium)
            dismissBtn.setImage(
                UIImage(systemName: "xmark", withConfiguration: config), for: .normal)
        } else if let image = UIImage(named: "keyboard_dismiss") {
            dismissBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
    }

    func updateIcon(iconType: String) {
        currentIconType = iconType

        if iconType == "none" {
            blockTypeBtn.isHidden = true
            return
        }

        blockTypeBtn.isHidden = false
        let imageName: String
        switch iconType {
        case "link":
            imageName = "link"
        case "image":
            imageName = "image"
        default:
            imageName = "paragraph"
        }

        if let image = UIImage(named: imageName) {
            blockTypeBtn.setImage(image.withRenderingMode(.alwaysTemplate), for: .normal)
        }
    }

    func updateFormattingState(isBold: Bool, isItalic: Bool, isCode: Bool, isStrikethrough: Bool) {
        boldBtn.tintColor = isBold ? .systemGreen : .label
        italicBtn.tintColor = isItalic ? .systemGreen : .label
        codeBtn.tintColor = isCode ? .systemGreen : .label
        strikethroughBtn.tintColor = isStrikethrough ? .systemGreen : .label

        let anyFormatActive = isBold || isItalic || isCode || isStrikethrough
        inlineFormatBtn.tintColor = anyFormatActive ? .systemGreen : .label
    }

    func collapseFormattingIfNeeded() {
        if isFormattingExpanded {
            isFormattingExpanded = false
            mainButtonsStack.alpha = 1
            mainButtonsStack.isHidden = false
            formattingButtonsStack.alpha = 0
            formattingButtonsStack.isHidden = true
            scrollView.setContentOffset(.zero, animated: false)
        }
    }
}
