Bugs list
[x] when double clicking on word it does focus is at the start not the end.
[x] when double clicking on word on desktop and instead of going fowarding and going backward than we shoud the reverse the anchor. Now focus depends where move the selection direction this is correct, but the anchor position on first word selection on desktop this should not be locked.
[x] Could not expand selection beyond non alphanumeric characters for example dots or commas.
[x] word boundaries on double click should be respected. The punctionuation should not selected.
[x] Arabic and other langs from rtl should be rendered from right to left.
[x] left and right arrow keys should move correctly with rtl. Now while moving from ltr to rtl bloks work. But there is an issue if we start from rtl block
[x] shortcuts does not work in other lang layouts.
[x] split function does not preserve block type.
[x] Could not expand selection beyond non alpha characters for example dots or commas. This happens with ctrl + arrow left and right.
[x] when selecting one word and typing, the word is not replaced
[x] when selecting one word and deleting, the word is not deleted.
[x] when selecting entire block and typing, the block is not replaced
[x] when selecting entire block and deleting, the block is not deleted
[x] Can not expand the selection using ctrl + shift + arrow left and right
[x] when triple clicking on block for selection the cursor is not at the end of the block.
[x] when triple clicking at two lines or more block the cursor is not rendered. It is rendered at the at beginning of the block and not the end of the block.
[x] Selection only covers middle part of text, not from top to bottom. This is talking about selection and text baseline, selection should cover all the text if it goes glyph goes under the bottom line. keywords alpahpics
[x] cursor is rendering is moved one line down when when it is at the end of a line.
[x] Rendering of cursor on second line does not work correctly, one first line it works but after moving down it becomse inacurate.
[x] when moving with arrows keys the selection is not reseted if we do not have shift key pressed. Same thing with ctrl + arrows keys.
[x] when selection going outside the screen the viewport should follow the selection.
[x] hold press and selecting down on mobile does not work correctly because cursor is not moving down.
[x] when end edge scrolling we should open keyboard on mobile.
[-] max selection dragging scroll speed should not be limited. Or limted but very large number. Because we don not how large the document could be.
[-] Maybe specify how large of document we should supprt.
[x] add three dots right of saving the opens drawer for page settings.
[x] change the font family in page settings
[x] add word count if enabled in setings.
[x] when clicking on the sides or outside the editor we should reset the selection.
[x] whe the whole window loses focus we need to render selection boxes with different color.
[x] ctrl + delete like vscode should work.
[x] when writing withing headers the text is converted to paragraphs for some reason.
[x] implement ctrl + A to select all text.
[x] add select all on mobile.
[x] If select all and right click the context menu disapears.
[x] link menu should not appear on context menu
[x] add placeholder on empty blocks when editing, on cursor position.
[x] empty blocks should be seen as selected.
[x] implement "/" functionality to open command palette.
[x] arrow up and arrow down skip lines and go for the blocks instead of going line by line.
[x] page up and page down should be implemented.
[x] when selection is active and we click arrow up or left then the cursot should go back to start of the selection.
[x] if we scroll to the bottom of the page and then type Ctrl + A and delete the text, we should scroll to the top. But now we fall outside outside the viewport.
[x] implement ctrl + C to copy text and ctrl + V to paste text (with HTML formatting) and ctrl + Shift + V to paste as plain text.
[x] improve pasting behivour and allow better clipboard content parsing.
[x] implement ctrl + X to cut text.
[x] When editing a block the inline styles disappearing
[x] add logic for for writing tracking markdown inlines styles.
[x] selection rendering is quite wrong now we need it is offseted little bit in widht if there inline style contenn.
[x] inserting charaters after inline style creates new inlines objects instead of add to the existing block.
[x] Render cursor function does not count for padding for example code.
[x] Inline text selection and cursor rendering has bit mismatch when calculating the position of the cursor and dimension of selection boxes
[x] when pressing enter on end of heading then we should create new paragraph not heading.
[x] Fix word boundary selection logic, it should not include punction and speical signs
[x] Fix reading empty file, should at least be one block
[x] ctrl + b should work in the editor.
[x] add image blocks
[ ] add unorded list block
[ ] add orded list block
[ ] add todo list block
[ ] Check devices compatiabities such ipad with keyboard. Pen input, stylus supprot. Handwriting.
[ ] on ios keyboard iland we should add active/inactive state for block type menu. External keyboard
[x] composition and other input methods such as IME should work.
[ ] voice input/speeh-to-text
[ ] Accessiblity input?
[ ] Autorcorrect/autocomplete
[ ] dragging text
[x] on android keyboard toolbar we should add active/inactive state for block type menu.
[ ] we should add inline formatting options in ios keyboard island.
[ ] we should add inline formatting options in android keyboard toolbar.
[ ] On desktop we should add formating inline options on cotnext menu.
[ ] mobile inline formatting options.
[ ] Add animation on scrolling to make more visually apealing.
[ ] Remove the markdown style when copying plain text.
[ ] Typing two spaces should exit inline styling, consult someone if this actaully good pratice.
[ ] consider adding selection dragging on mobiles on both anchor and foucus. Like it is on ios. This for epxanding the selection and shrinking.
[x] add link for inline rendering format but the styles should be resvered for links. Add parsing logic for links as well. Add menu for changing the link tile.
[x] ctrl click or command click should open the link. But it should not matter if it happens in fly while selecting.
[x] hover on link should radix toolip and preview and with edit edit button and copy button. clicking on link preview should open it.
[ ] how to do the above on mobile.
[ ] do design overhaul.
[ ] Add support for windows ctrl + Y and make sure the shortcuts are intuitiave for all opearting systems.
[ ] consider if we need more animation and fluid text edting for example when I delete large portion text or copy large portion of text. Maybe show the scroll bar in this case.
[ ] rendering is triggered to many times.
[ ] override webiew defaul 404 page
[x] rtl inline format rendering edge cases
[x] render should be more efficent if we schedule it
[x] cursor should not be visable if we haeve selection
[ ] group undo and redo to words.
[x] bring back the old tree code from l4r for saving pages and sort them into trees.
[x] When loading a page first. it is overrideing the page with empty state. The update endpoint is being called before the page is loaded and is overriding with empty string
[x] top bar is not same color
[x] when openign or creating a page we should focus on page.
[x] opening or creating page on mobile should close floaty sidebar.
[x] when deleting current page we should close the current page.
[x] Tree page not working as it was in l4r˝
[x] i can still type when there is no focus
[x] link overlay not rendering correcty
[x] copy not copying inline formating
[x] updating tile twichs a litle
[x] updating title of parent should update breadcrum
[x] dragging pages on mobile
[x] scrolling on sidebar misread the scrolling with dragging.
[ ] offline support maybe api backend in service workers so we can for example update titles
[ ] add tranlsation keys
[x] when compostion is on and delete we delete it delete behind the composition.
[ ] Read title from document
[x] mandrians characters are not working with with selection.
[x] compoition characters are still left in viewport but composition is cancelled.
[x] composition toolbar is in wrong place.
[x] if we are composing at end of line than compoistion toolbar is stays same place this is worng.
[x] page up and down, home and end no longer working
[ ] deleting emogjs is broken
[x] in extermly long word that could not possible exist contactenated with composition than the compositon breaks in wrong way.
[x] chiense text are not wrapping correctly
[x] word navigation (Ctrl+Arrow) and selection (Ctrl+Shift+Arrow, double-click)
[x] when text is going out of bounds then some character goes missing
[ ] ctrl + S should be prevented
[ ] rendering a large block has perforamce issues.
[ ] haptics on scrollbar. Improvement for scollbar.
[x] scrolling down while we have link overlay does not hide it.
[x] Undo/redo is broken on composition
[x] Navigation with arrow keys (home,end,page up and down too)during composition is broken
[x] on rtl left compositon in not underlined
[x] one delete on mobile keyboard does cancel the compositon
[x] Very long composition text does not break correcly, like if do not accept compositon and do it in batch.
[x] start composition and unfocus the page does not cancel compositon.
[-] Composition state cleanup on error
[x] ios top toolbar is too high under the os notification bar
[ ] ios keyboard island is always visibile if for normal text inputs
[x] escaping slash menu does not work.
[x] word count does not work with CJK letters
[x] pasting is not invalidating blocked cached height.
[x] pasting into another text field such as title text field it is not working.
[ ] pasting tables from webpages should preserve table structure or convert to readable format
[ ] pasting images from webpages should handle images (either embed or show placeholder)
[ ] pasting lists (ul/ol) should preserve list structure and convert to list blocks
[ ] when there is a selection we should count the selection word count not the whole document.
[x] backspace deletion on empty line that has heading after clear the styling.
[x] selection on empty lines not working in some cases.
[x] placeholder should not be vsibile when we have selection
[x] dragging and dropping pagelink on same position it swaps position withe the one under.
[x] when the editor is not loaded options should not be shown
[x] clicking close to an image trigger upload menu. Clicking on image should persist it should not activate upload menu if we are pointer inside the image.
[x] rendering cover image artifcat. The image has border
[x] Rendering image has supper low resolution. Even though uploaded image is good
[x] upload menu should be fixed in one place. If being clicked repeadly on upload image menu should not move.
[x] i need to click two times outside to close image upload menu.
[x] click outside the editor does not close the image upload menu or context menu.
[x] on hovering on a link near the edge, than the tooltip should be fully visible.
[x] on hover on image we should show the button for swapping image.
[x] cache image response if it fails now it requests again and again
[x] can not scroll when if image is a placeholder
[x] scrolling should not be active on locked mode
[x] we should be select an image.
[x] Image should be selectable. We should be able to select an image.
[x] going arrow left on start of text block that has image behind should select the iamge. Right arrow should work the same.
[x] arrow up on image should create new text block.
[x] image place holder should much smaller in the height
[x] image on the edge is bit higher than the normal images
[x] context menu is direcly closing on mobile.
[x] can not clear selection on moble if click outside or on top/bottom padding
[x] image cover bleeding on top edge stopped working
[x] If i delete some text at the end of the document, the scroll size decraese, but the viewport does not update.
[x] If we create new block before image and or after image and it not used we move down, the we should delete it.
[x] should not image drag more than its container.
[x] drag the images.
[-] we should not store the image in absolute values we should istead use relative values such as perecentage.
[x] when click outside the image we should lose focus
[x] conflict between scroll bar and drag handle.
[ ] placeholder image should drag handles.
[ ] change position of cover image.
[ ] Remove an image. Improve EditImagePopover.
[x] word count should not count images.
[ ] We should open the context menu or 
[ ] copy and paste should work with images.
[ ] upload menu should be fixed in one place. If being clicked repeadly on upload image menu should not move.
[ ] scrollbar should not hit bottom porition on mobile (or at least on ios)
[ ] hide editimagepopover on mobile
[ ] hide scrollbar when not scrolling
[ ] one click on selection should trigger context menu.
[x] focus issue on context menu
[x] select all on mobile not working really, i we already have selection on some block. It would select from start of that exisitng selectio until the end.
[x] Android keyboard rendering stops after tap in selection - fixed by updating cursor position while preserving selection
[ ] I want drag context menu activation like native menu have.
[ ] drag thumb drag detection on mobile should have buffer area.
[ ] selection drag rtl is broken
[ ] draging image handle and scrolling should work too.
[x] android toolbar is super broken.
[x] scroll on pagearea is shard on mobile
[x] clicking on other text inputs (sidebar, page title) should not show toolbar/keyboard island
[ ] ios block menu does not have same height as the keyboard. 
[ ] two finger scroll
- : means not planed or considered
  x : done
  : not done
