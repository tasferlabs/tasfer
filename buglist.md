# Cypher Bugs list

## Canvas Rendering & Performance
- [x] Selection only covers middle part of text, not from top to bottom. This is talking about selection and text baseline, selection should cover all the text if it goes glyph goes under the bottom line. keywords alpahpics
- [x] cursor is rendering is moved one line down when when it is at the end of a line.
- [x] Rendering of cursor on second line does not work correctly, one first line it works but after moving down it becomse inacurate.
- [x] Render cursor function does not count for padding for example code.
- [x] Inline text selection and cursor rendering has bit mismatch when calculating the position of the cursor and dimension of selection boxes
- [x] selection rendering is quite wrong now we need it is offseted little bit in widht if there inline style contenn.
- [x] rendering is triggered to many times.
- [x] render should be more efficent if we schedule it
- [x] cursor should not be visable if we haeve selection
- [x] canvas glitch on resizing.
- [ ] rendering a large block has perforamce issues.
- [ ] more shimming rendering
- [ ] should cursor be visible when out of screen
- [x] placeholder should not be vsibile when we have selection
- [x] add placeholder on empty blocks when editing, on cursor position.
- [x] empty blocks should be seen as selected.

## Text Selection & Cursor
- [x] when double clicking on word it does focus is at the start not the end.
- [x] when double clicking on word on desktop and instead of going fowarding and going backward than we shoud the reverse the anchor. Now focus depends where move the selection direction this is correct, but the anchor position on first word selection on desktop this should not be locked.
- [x] Could not expand selection beyond non alphanumeric characters for example dots or commas.
- [x] word boundaries on double click should be respected. The punctionuation should not selected.
- [x] Could not expand selection beyond non alpha characters for example dots or commas. This happens with ctrl + arrow left and right.
- [x] Can not expand the selection using ctrl + shift + arrow left and right
- [x] when triple clicking on block for selection the cursor is not at the end of the block.
- [x] when triple clicking at two lines or more block the cursor is not rendered. It is rendered at the at beginning of the block and not the end of the block.
- [x] when moving with arrows keys the selection is not reseted if we do not have shift key pressed. Same thing with ctrl + arrows keys.
- [x] when selection going outside the screen the viewport should follow the selection.
- [x] when clicking on the sides or outside the editor we should reset the selection.
- [x] whe the whole window loses focus we need to render selection boxes with different color.
- [x] if click outside the box selection should be lost.
- [x] implement ctrl + A to select all text.
- [x] when selecting one word and typing, the word is not replaced
- [x] when selecting one word and deleting, the word is not deleted.when selecting entire block and typing, the block is not replaced
- [x] when selecting entire block and deleting, the block is not deleted
- [x] Fix word boundary selection logic, it should not include punction and speical signs
- [x] selection on empty lines not working in some cases.
- [x] arrow up and arrow down skip lines and go for the blocks instead of going line by line.
- [x] when selection is active and we click arrow up or left then the cursot should go back to start of the selection.
- [ ] max selection dragging scroll speed should not be limited. Or limted but very large number. Because we don not how large the document could be.
- [ ] empty line and selection drag
- [ ] Cursor reverted to back of the page for some reason

## Keyboard & Shortcuts
- [x] shortcuts does not work in other lang layouts.
- [x] ctrl + delete like vscode should work.
- [x] implement ctrl + C to copy text and ctrl + V to paste text (with HTML formatting) and ctrl + Shift + V to paste as plain text.
- [x] implement ctrl + X to cut text.
- [x] ctrl + b should work in the editor.
- [x] Add support for windows ctrl + Y and make sure the shortcuts are intuitiave for all opearting systems.
- [x] page up and page down should be implemented.
- [x] page up and down, home and end no longer working
- [ ] ctrl + S should be prevented
- [ ] CTRL + F
- [ ] CTRL + S to save the conntent as markdown.
- [ ] page up and down should work with visual blocks.

## RTL & Internationalization
- [x] Arabic and other langs from rtl should be rendered from right to left.
- [x] left and right arrow keys should move correctly with rtl. Now while moving from ltr to rtl bloks work. But there is an issue if we start from rtl block
- [x] rtl should work with lists
- [x] rtl inline format rendering edge cases
- [x] arabic script stopped working after impelemting crdt
- [x] arabic text not breaking correcttly
- [x] selection drag rtl is broken
- [x] indent with mixed direction rtl todo
- [ ] select arabic text and arrow left/right does not work as expected.
- [ ] add tranlsation keys

## Composition & IME
- [x] composition and other input methods such as IME should work.
- [x] mandrians characters are not working with with selection.
- [x] compoition characters are still left in viewport but composition is cancelled.
- [x] composition toolbar is in wrong place.
- [x] if we are composing at end of line than compoistion toolbar is stays same place this is worng.
- [x] in extermly long word that could not possible exist contactenated with composition than the compositon breaks in wrong way.
- [x] chiense text are not wrapping correctly
- [x] when compostion is on and delete we delete it delete behind the composition.
- [x] word navigation (Ctrl+Arrow) and selection (Ctrl+Shift+Arrow, double-click)
- [x] Undo/redo is broken on composition
- [x] Navigation with arrow keys (home,end,page up and down too)during composition is broken
- [x] on rtl left compositon in not underlined
- [x] one delete on mobile keyboard does cancel the compositon
- [x] Very long composition text does not break correcly, like if do not accept compositon and do it in batch.
- [x] start composition and unfocus the page does not cancel compositon.
- [x] word count does not work with CJK letters
- [ ] Composition state cleanup on error
- [ ] Can not use arrow when compositon active.

## Inline Formatting & Styles
- [x] When editing a block the inline styles disappearing
- [x] add logic for for writing tracking markdown inlines styles.
- [x] inserting charaters after inline style creates new inlines objects instead of add to the existing block.
- [x] when pressing enter on end of heading then we should create new paragraph not heading.
- [x] when writing withing headers the text is converted to paragraphs for some reason.
- [x] ending with "backtick" not wokring
- [x] Clearing one letter, clears everything in format span
- [x] format span accumlation
- [ ] Combination of bold and italic did not work one time.
- [ ] Typing two spaces should exit inline styling, consult someone if this actaully good pratice.
- [ ] Typing double space should clear fomrating or may do it by context menu
- [ ] strike through should follow same color as text

## Links
- [x] add link for inline rendering format but the styles should be resvered for links. Add parsing logic for links as well. Add menu for changing the link tile.
- [x] ctrl click or command click should open the link. But it should not matter if it happens in fly while selecting.
- [x] hover on link should radix toolip and preview and with edit edit button and copy button. clicking on link preview should open it.
- [x] how to do the above on mobile.
- [x] on hovering on a link near the edge, than the tooltip should be fully visible.
- [x] link menu should not appear on context menu
- [x] scrolling down while we have link overlay does not hide it.
- [x] link overlay not rendering correcty
- [ ] Add way to add link on desktop
- [ ] Pasting link should make link after we typing space
- [ ] Pressing enter before link make the link disapears.

## Block Operations
- [x] split function does not preserve block type.
- [x] list split at the end not creating new item.
- [x] Fix reading empty file, should at least be one block
- [x] backspace deletion on empty line that has heading after clear the styling.
- [x] implement "/" functionality to open command palette.
- [x] escaping slash menu does not work.
- [x] add unorded list block
- [x] add orded list block
- [x] add todo list block
- [x] hover on checkbox should be pointer
- [x] click on checkbox no longer working
- [x] delete at start of text after an image, delete the text.
- [ ] intermidate state in todo list
- [ ] Sequential numbered list not working with indents.
- [ ] Quote block
- [ ] code block
- [ ] maths code block
- [ ] can not undo clear list item operation
- [ ] typing letters that conlicde with markdown serlization should be escaped
- [ ] too many functions the loops all the blocks.
- [ ] genreatic get block at positons

## Images
- [x] add image blocks
- [x] clicking close to an image trigger upload menu. Clicking on image should persist it should not activate upload menu if we are pointer inside the image.
- [x] rendering cover image artifcat. The image has border
- [x] Rendering image has supper low resolution. Even though uploaded image is good
- [x] upload menu should be fixed in one place. If being clicked repeadly on upload image menu should not move.
- [x] i need to click two times outside to close image upload menu.
- [x] click outside the editor does not close the image upload menu or context menu.
- [x] on hover on image we should show the button for swapping image.
- [x] cache image response if it fails now it requests again and again
- [x] can not scroll when if image is a placeholder
- [x] we should be select an image.
- [x] Image should be selectable. We should be able to select an image.
- [x] going arrow left on start of text block that has image behind should select the iamge. Right arrow should work the same.
- [x] arrow up on image should create new text block.
- [x] image place holder should much smaller in the height
- [x] image on the edge is bit higher than the normal images
- [x] image cover bleeding on top edge stopped working
- [x] If we create new block before image and or after image and it not used we move down, the we should delete it.
- [x] should not image drag more than its container.
- [x] drag the images.
- [x] when click outside the image we should lose focus
- [x] conflict between scroll bar and drag handle.
- [x] placeholder image should drag handles.
- [x] word count should not count images.
- [x] copy and paste should work with images.
- [x] tapping under image that has no other blocks under should create new text block.
- [x] draging image handle and scrolling should work too.
- [x] hide editimagepopover on mobile
- [ ] we should not store the image in absolute values we should istead use relative values such as perecentage.
- [ ] change position of cover image.
- [ ] Remove an image. Improve EditImagePopover.
- [ ] upload menu should be fixed in one place. If being clicked repeadly on upload image menu should not move.
- [ ] context menu options on image are meaningless
- [ ] should we embed images?
- [ ] iamge place holder

## Clipboard (Copy/Paste)
- [x] improve pasting behivour and allow better clipboard content parsing.
- [x] copy not copying inline formating
- [x] pasting is not invalidating blocked cached height.
- [x] pasting into another text field such as title text field it is not working.
- [x] pasting images from webpages should handle images.
- [x] crdt pasting docoumet paste only first block
- [ ] Remove the markdown style when copying plain text.
- [ ] pasting lists (ul/ol) should preserve list structure and convert to list blocks
- [ ] copying to do list block copys as markdown.
- [ ] Pasting from screenshot does not work.

## Undo/Redo
- [ ] group undo and redo to words.
- [ ] wehn deleting a block and undoing it merges them

## Scrolling & Viewport
- [x] if we scroll to the bottom of the page and then type Ctrl + A and delete the text, we should scroll to the top. But now we fall outside outside the viewport.
- [x] If i delete some text at the end of the document, the scroll size decraese, but the viewport does not update.
- [x] haptics on scrollbar. Improvement for scollbar.
- [x] scrollbar should not hit bottom porition on mobile (or at least on ios)
- [x] hide scrollbar when not scrolling
- [x] scrolling should not be active on locked mode
- [x] two finger scroll
- [ ] Three-Finger Gestures
- [ ] habtic on selecting scroll handle maybe.
- [ ] undo or any edting opeartion should ensureCursor visible
- [ ] Schedule tag should be hidden when scrolling.

## Context Menu & Menus
- [x] If select all and right click the context menu disapears.
- [x] On desktop we should add formating inline options on cotnext menu.
- [x] one click on selection should trigger context menu.
- [x] focus issue on context menu
- [ ] if there are mutliple formats should we close context menu directly on click on format sub menu?
- [ ] I want drag context menu activation like native menu have.
- [ ] start dag in editor padding and continue is not working really well.

## Mobile (iOS & Android)
- [x] hold press and selecting down on mobile does not work correctly because cursor is not moving down.
- [x] when end edge scrolling we should open keyboard on mobile.
- [x] add select all on mobile.
- [x] consider adding selection dragging on mobiles on both anchor and foucus. Like it is on ios. This for epxanding the selection and shrinking.
- [x] on ios keyboard iland we should add active/inactive state for block type menu. External keyboard
- [x] on android keyboard toolbar we should add active/inactive state for block type menu.
- [x] we should add inline formatting options in ios keyboard island.
- [x] we should add inline formatting options in android keyboard toolbar.
- [x] context menu is direcly closing on mobile.
- [x] can not clear selection on moble if click outside or on top/bottom padding
- [x] select all on mobile not working really, i we already have selection on some block. It would select from start of that exisitng selectio until the end.
- [x] Android keyboard rendering stops after tap in selection - fixed by updating cursor position while preserving selection
- [x] drag thumb drag detection on mobile should have buffer area.
- [x] android toolbar is super broken.
- [x] scroll on pagearea is shard on mobile
- [x] clicking on other text inputs (sidebar, page title) should not show toolbar/keyboard island
- [x] editing issue on android. Can not edit text after selection.
- [x] on landscape oritentation the safe area taking to much and it is uncessary.
- [x] Safe area on sidebar
- [x] dynamic island hide buttons on iphone keyboard toolbar
- [x] dragging pages on mobile
- [ ] I want to drag cursor. Solved by padding click.
- [ ] ios block menu does not have same height as the keyboard.
- [ ] could we disable edge navigation on andorid?
- [ ] everything should suited for mobile, including flaoting menu.
- [ ] checkbox click area should be bigger on mobile.
- [ ] drag handles should be bigger on mobile.
- [ ] word counter should be visible above the keyboard.
- [ ] import and export not working on mobile
- [ ] debug why toolbar disappear sometimes. constraints?
- [ ] tapping at the end if pages does not select the end of a to do list.

## iOS App
- [x] ios top toolbar is too high under the os notification bar
- [x] ios keyboard island is always visibile if for normal text inputs
- [x] on deploy ios blacking out
- [ ] override webiew defautl 404 page

## Android App
- [ ] could we disable edge navigation on andorid?

## Sidebar & Page Navigation
- [x] bring back the old tree code from l4r for saving pages and sort them into trees.
- [x] Tree page not working as it was in l4r˝
- [x] when openign or creating a page we should focus on page.
- [x] opening or creating page on mobile should close floaty sidebar.
- [x] when deleting current page we should close the current page.
- [x] scrolling on sidebar misread the scrolling with dragging.
- [x] title not updating in sidebar when triggering auto update.
- [x] Hover on buttons for pagelink that active should have better style
- [x] dawers should have scroll
- [ ] Continue improving sidebar and pagelink
- [ ] Flaoting sidebar should be suited flr mobile
- [ ] Can not drop a page on thrid level or more
- [ ] Optimistics updates in tree structure
- [ ] Large bottom badding when opening a page tha has children.
- [ ] sidebar safe area
- [ ] canvas safe area

## UI & Styling
- [x] add three dots right of saving the opens drawer for page settings.
- [x] change the font family in page settings
- [x] add word count if enabled in setings.
- [x] top bar is not same color
- [x] updating tile twichs a litle
- [x] updating title of parent should breadcrum
- [x] confirmation dialog when leaving page is reversed.
- [ ] Add more animations to make the app more visually apealing.
- [ ] do design overhaul.
- [ ] Maybe specify how large of document we should supprt.
- [ ] should placeholder be visible on out of focus?
- [ ] when there is a selection we should count the selection word count not the whole document.
- [ ] action bar options should only visible on editor page
- [ ] theme not refelecting dirreclty after we choose system theme on mobile.
- [ ] Checkbox square should be bit brighter on dark mode for contrast.
- [ ] increase font size for people who wants it. Use rem
- [ ] Collberatives cursors cutoff because i reduced the padding

## CRDT & Sync
- [x] tapping enter to split blocks does not not work well with crdt opreations.
- [x] when typing in the middle the other tab insert to the end.
- [x] remote caret should not be showen when there is selection.
- [x] remote caret should have name tag
- [x] remote selection should be seen in visual blocks
- [x] we should show blobs of remote users in topactionbar
- [x] fix stoarge problems with crdt
- [x] change content should reculate hights/documentb height in
- [x] on load document there is not scrollbar
- [x] 1. Fix IDs
- [x] 2. chair squashing
- [x] 2. op chain
- [x] We should brodacast page delete
- [x] reload on disconencted the operations are lost.
- [x] close connections gracefully on app close
- [ ] Interleaving on Concurrent Inserts
- [ ] Short Peer IDs
- [ ] tombstone pruning
- [ ] 3. Binary encoding
- [ ] 4. Delta compression
- [ ] Consolidate @apps/web/src/sync/index.ts operations more
- [ ] peforamnce issues after crdt
- [ ] do we have unccessary long ids in snapshot
- [ ] broadcast new update

## API & Backend
- [x] When loading a page first. it is overrideing the page with empty state. The update endpoint is being called before the page is loaded and is overriding with empty string
- [x] Database Operations Table
- [x] Read title from document
- [x] offline support maybe api backend in service workers so we can for example update titles
- [ ] loading page is slow
- [ ] loading apge should show spinner.
- [ ] test users and test functions
- [ ] improve websockets to handle more events.
- [ ] We lose data sometimes! Is it because lf bad network connetion.
- [ ] All listed pages are not available offline, how should we fix it?
- [ ] test native storage.

## Snapshots
- [x] snapshotting
- [x] snapshot restore
- [x] why snapshot have hlc clock
- [ ] add snapshot previewing
- [ ] No scroll bar in sapshots

## Serialization & Data
- [x] saving indictor loads for ever when editing offline.
- [x] invalidate cache when changing font.
- [x] i can still type when there is no focus
- [ ] deleting emogjs is broken
- [ ] memory leak somehow the old state being presisted on hot reloading.
- [ ] export/import features
- [ ] protocol for opening cypher links.
- [x] If close the page sometimes we do not getconfimration dialog, maybe on bad network.
- [ ] Update dialog show up without a reason sometimes.

## Drag & Drop
- [x] dragging and dropping pagelink on same position it swaps position withe the one under.
- [ ] dragging text
- [ ] dragging blocks

## Input Devices
- [ ] Pen input, stylus support. Handwriting.
- [ ] voice input/speeh-to-text
- [ ] Accessiblity input?
- [ ] Autorcorrect/autocomplete

## Search & Navigation
- [ ] Search functioanllity
- [ ] Onboarding
- [ ] Opening cypher.md loads no "pages found".
- [ ] Creating calendar accross devices does not sync

## Schedule (Calendar Features)
- [ ] /new keyword for new event/page
- [ ] Change placeholder to event in calenadr event
- [ ] Typing p while editing an event goes foward in the calendar,
- [ ] Cant not change event duration
- [ ] Export should have schedule meta data

## Command Palette
- [ ] We should be able to navigate page with cmd + k

## Style
- [ ] Change font serif font to one that suites the platforms
- [ ] Breadcrumb on event
