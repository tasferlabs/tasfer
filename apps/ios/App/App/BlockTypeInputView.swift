import UIKit

class BlockTypeInputView: UIView, UIInputViewAudioFeedback {
    var onSelect: ((String) -> Void)?
    private var keyboardHeightConstraint: NSLayoutConstraint?
    static var cachedKeyboardHeight: CGFloat = 291

    var enableInputClicksWhenVisible: Bool {
        return true
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupUI()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: Self.cachedKeyboardHeight)
    }

    func updateHeight(_ height: CGFloat) {
        keyboardHeightConstraint?.constant = height
        invalidateIntrinsicContentSize()
    }

    private func setupUI() {
        self.autoresizingMask = [.flexibleHeight]

        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)

        let headerLabel = UILabel()
        headerLabel.text = "Turn into"
        headerLabel.font = UIFont.systemFont(ofSize: 16, weight: .medium)
        headerLabel.textColor = .label
        headerLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(headerLabel)

        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.showsVerticalScrollIndicator = true
        container.addSubview(scrollView)

        let gridContainer = UIView()
        gridContainer.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(gridContainer)

        let types = [
            ("Paragraph", "paragraph", "text"),
            ("Heading 1", "heading1", "heading1"),
            ("Heading 2", "heading2", "heading2"),
            ("Heading 3", "heading3", "heading3"),
            ("Numbered List", "numbered_list", "list_ordered"),
            ("Task List", "todo_list", "list_todo"),
            ("Bulleted List", "bullet_list", "list"),
            ("Image", "image", "image"),
            ("Divider", "line", "line"),
        ]

        var buttons: [UIButton] = []
        for (title, value, iconName) in types {
            let button = UIButton(type: .system)
            button.setTitle(title, for: .normal)
            button.backgroundColor = .tertiarySystemGroupedBackground
            button.layer.cornerRadius = 8
            button.setTitleColor(.label, for: .normal)
            button.contentHorizontalAlignment = .left
            button.titleLabel?.font = UIFont.systemFont(ofSize: 15)
            button.translatesAutoresizingMaskIntoConstraints = false

            if let iconImage = UIImage(named: iconName) {
                button.setImage(iconImage.withRenderingMode(.alwaysTemplate), for: .normal)
                button.tintColor = .label
                button.imageEdgeInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 12)
                button.titleEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 0)
                button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
            } else {
                button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
            }

            let action = UIAction { [weak self] _ in
                self?.onSelect?(value)
            }
            button.addAction(action, for: .touchUpInside)

            gridContainer.addSubview(button)
            buttons.append(button)
        }

        keyboardHeightConstraint = heightAnchor.constraint(
            equalToConstant: Self.cachedKeyboardHeight)
        keyboardHeightConstraint?.isActive = true

        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: topAnchor),
            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
            container.bottomAnchor.constraint(equalTo: bottomAnchor),

            headerLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
            headerLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            headerLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20),

            scrollView.topAnchor.constraint(equalTo: headerLabel.bottomAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -16),

            gridContainer.topAnchor.constraint(equalTo: scrollView.topAnchor),
            gridContainer.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor, constant: 16),
            gridContainer.trailingAnchor.constraint(
                equalTo: scrollView.trailingAnchor, constant: -16),
            gridContainer.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor),
            gridContainer.widthAnchor.constraint(equalTo: scrollView.widthAnchor, constant: -32),
        ])

        // Grid layout (2 columns)
        NSLayoutConstraint.activate([
            buttons[0].topAnchor.constraint(equalTo: gridContainer.topAnchor),
            buttons[0].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[0].heightAnchor.constraint(equalToConstant: 60),
            buttons[0].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[1].topAnchor.constraint(equalTo: gridContainer.topAnchor),
            buttons[1].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[1].heightAnchor.constraint(equalToConstant: 60),
            buttons[1].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[2].topAnchor.constraint(equalTo: buttons[0].bottomAnchor, constant: 8),
            buttons[2].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[2].heightAnchor.constraint(equalToConstant: 60),
            buttons[2].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[3].topAnchor.constraint(equalTo: buttons[1].bottomAnchor, constant: 8),
            buttons[3].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[3].heightAnchor.constraint(equalToConstant: 60),
            buttons[3].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[4].topAnchor.constraint(equalTo: buttons[2].bottomAnchor, constant: 8),
            buttons[4].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[4].heightAnchor.constraint(equalToConstant: 60),
            buttons[4].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[5].topAnchor.constraint(equalTo: buttons[3].bottomAnchor, constant: 8),
            buttons[5].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[5].heightAnchor.constraint(equalToConstant: 60),
            buttons[5].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[6].topAnchor.constraint(equalTo: buttons[4].bottomAnchor, constant: 8),
            buttons[6].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[6].heightAnchor.constraint(equalToConstant: 60),
            buttons[6].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[7].topAnchor.constraint(equalTo: buttons[5].bottomAnchor, constant: 8),
            buttons[7].trailingAnchor.constraint(equalTo: gridContainer.trailingAnchor),
            buttons[7].heightAnchor.constraint(equalToConstant: 60),
            buttons[7].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[8].topAnchor.constraint(equalTo: buttons[6].bottomAnchor, constant: 8),
            buttons[8].leadingAnchor.constraint(equalTo: gridContainer.leadingAnchor),
            buttons[8].heightAnchor.constraint(equalToConstant: 60),
            buttons[8].widthAnchor.constraint(
                equalTo: gridContainer.widthAnchor, multiplier: 0.5, constant: -4),

            buttons[8].bottomAnchor.constraint(lessThanOrEqualTo: gridContainer.bottomAnchor),
        ])
    }
}
