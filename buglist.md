Bugs list
[x] when double clicking on word it does focus is at the start not the end.
[x] Could not expand selection beyond non alpha characters for example dots or commas.
[x] split function does not preserve block type.
[x] Could not expand selection beyond non alpha characters for example dots or commas. This happens with ctrl + arrow left and right.
[x] splitBlock reserves the block type, but when going back with delete the block type is lost.
[x] when selecting one word and typing, the word is not replaced
[x] when selecting one word and deleting, the word is not deleted.
[x] when selecting entire block and typing, the block is not replaced
[x] when selecting entire block and deleting, the block is not deleted
[x] Can not expand the selection using ctrl + shift + arrow left and right
[x] when triple clicking on block for selection the cursor is not at the end of the block.
[x] when triple clicking at two lines or more block the cursor is not rendered. It is rendered at the at beginning of the block and not the end of the block.
[x] Selection only covers middle part of text, not from top to bottom.
[x] cursor is rendering is moved one line down when when it is at the end of a line.
[x] Rendering of cursor on second line does not work correctly, one first line it works but after moving down it becomse inacurate.
[x] when moving with arrows keys the selection is not reseted if we do not have shift key pressed. Same thing with ctrl + arrows keys.
[x] when selection going outside the screen the viewport should follow the selection.
[x] hold press and selecting down on mobile does not work correctly because cursor is not moving down.
[x] when end edge scrolling we should open keyboard on mobile.
[x] when clicking on the sides or outside the editor we should reset the selection.
[x] ctrl + delete like vscode should work.
[x] when writing withing headers the text is converted to paragraphs for some reason.
[x] implement ctrl + A to select all text.
[x] add placeholder on empty blocks when editing, on cursor position.
[x] empty blocks should be seen as they selected.
[x] implement "/" functionality to open command palette.
[x] arrow up and arrow down skip lines and go for the blocks instead of going line by line.
[x] page up and page down should be implemented.
[x] when selection is active and we click arrow up or left then the cursot should go back to start of the selection.
[x] if we scroll to the bottom of the page and then type Ctrl + A and delete the text, we should scroll to the top. But now we fall outside outside the viewport.
[x] add extra space on mobile at the end of the page so there is place for the keyboard.
[x] implement ctrl + C to copy text and ctrl + V to paste text (with HTML formatting) and ctrl + Shift + V to paste as plain text.
[x] implement ctrl + X to cut text.
[x] When editing a block the inline styles disappearing
[x] add logic for for writing tracking markdown inlines styles.
[x] selection rendering is quite wrong now we need it is offseted little bit in widht if there inline style contenn.
[x] inserting charaters after inline style creates new inlines objects instead of add to the existing block.
[x] Render cursor function does not count for padding for example code.
[x] Inline text selection and cursor rendering has bit mismatch when calculating the position of the cursor and dimension of selection boxes
[ ] when pressing enter on end of heading then we should create new paragraph.
[ ] Fix word boundary selection logic, it should not include punction and speical signs
[ ] Fix reading empty file, should at least be one block
[ ] group undo and redo to words.