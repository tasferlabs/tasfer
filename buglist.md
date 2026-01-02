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
[ ] max selection dragging scroll speed should not be limited. Or limted but very large number. Because we don not how large the document could be.
[ ] Maybe specify how large of document we should supprt.
[ ] add word count if enabled in setings. Consider if we could mange count all the words or we need to implement estimation somehow.
[x] when clicking on the sides or outside the editor we should reset the selection.
[ ] whe the whole window loses focus we need to render selection boxes with different color.
[x] ctrl + delete like vscode should work.
[x] when writing withing headers the text is converted to paragraphs for some reason.
[x] implement ctrl + A to select all text.
[ ] add select all on mobile.
[x] add placeholder on empty blocks when editing, on cursor position.
[x] empty blocks should be seen as selected.
[x] implement "/" functionality to open command palette.
[x] arrow up and arrow down skip lines and go for the blocks instead of going line by line.
[x] page up and page down should be implemented.
[x] when selection is active and we click arrow up or left then the cursot should go back to start of the selection.
[x] if we scroll to the bottom of the page and then type Ctrl + A and delete the text, we should scroll to the top. But now we fall outside outside the viewport.
[x] implement ctrl + C to copy text and ctrl + V to paste text (with HTML formatting) and ctrl + Shift + V to paste as plain text.
[ ] improve pasting behivour and allow better clipboard content parsing.
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
[ ] ctrl + b and other shorcuts should change the inline the text style.
[ ] add image blocks
[ ] add unorded list block
[ ] add orded list block
[ ] add todo list block
[ ] Choosing a context menu by dragging not avaliable
[ ] Check devices compatiabities such ipad with keyboard. Pen input, stylus supprot. Handwriting.
[ ] on ios keyboard iland we should add active/inactive state for block type menu. External keyboard
[x] composition and other input methods such as IME should work.
[ ] voice input/speeh-to-text
[ ] Accessiblity input?
[ ] Autorcorrect/autocomplete
[ ] dragging text
[ ] on android keyboard toolbar we should add active/inactive state for block type menu.
[ ] we should add inline formatting options in ios keyboard island.
[ ] we should add inline formatting options in android keyboard toolbar.
[ ] On desktop we should add formating inline options on cotnext menu.
[ ] Add animation on scrolling to make more visually apealing.
[ ] Remove the markdown style when copying plain text.
[ ] Typing to spaces should exit inline styling, consult someone if this actaully good pratice.
[ ] consider adding selection dragging on mobiles on both anchor and foucus. Like it is on ios. This for epxanding the selection and shrinking.
[x] add link for inline rendering format but the styles should be resvered for links. Add parsing logic for links as well. Add menu for changing the link tile.
[x] ctrl click or command click should open the link. But it should not matter if it happens in fly while selecting.
[x] hover on link should radix toolip and preview and with edit edit button and copy button. clicking on link preview should open it.
[ ] how to do the above on mobile.
[ ] bring back the old tree code from l4r for saving pages and sort them into trees.
[ ] do design overhaul.
[ ] Add support for windows ctrl + Y and make sure the shortcuts are intuitiave for all opearting systems.
[ ] consider if we need more animation and fluid text edting for example when I delete large portion text or copy large portion of text. Maybe show the scroll bar in this case.
[ ] rendering is triggered to many times.
[ ] override webiew defaul 404 page
[x] rtl inline format rendering edge cases
[ ] complex mandrians characters are not working with with selection.
[ ] render should be more efficent if we schedule it
[ ] cursor should not be visable if we haeve selection
[ ] group undo and redo to words.
[ ] When loading a page first. it is overrideing the page with empty state. The update endpoint is being called before the page is loaded and is overriding with empty string
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
[ ] when compostion is on and delete we delete it delete behind the composition.
[ ] Read title from document
[ ] compoition characters are still left in viewport but composition is cancelled.
[ ] composition toolbar is in wrong place.
[x] page up and down, home and end no longer working