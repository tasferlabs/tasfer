Cypher Bugs list

Canvas Rendering & Performance

Selection only covers middle part of text, not from top to bottom. This is talking about selection and text baseline, selection should cover all the text if it goes glyph goes under the bottom line. keywords alpahpics

cursor is rendering is moved one line down when when it is at the end of a line.

Rendering of cursor on second line does not work correctly, one first line it works but after moving down it becomse inacurate.

Render cursor function does not count for padding for example code.

Inline text selection and cursor rendering has bit mismatch when calculating the position of the cursor and dimension of selection boxes

selection rendering is quite wrong now we need it is offseted little bit in widht if there inline style contenn.

rendering is triggered to many times.

render should be more efficent if we schedule it

cursor should not be visable if we haeve selection

canvas glitch on resizing.

rendering a large block has perforamce issues.

more shimming rendering

should cursor be visible when out of screen

placeholder should not be vsibile when we have selection

add placeholder on empty blocks when editing, on cursor position.

empty blocks should be seen as selected.



Text Selection & Cursor

when double clicking on word it does focus is at the start not the end.

when double clicking on word on desktop and instead of going fowarding and going backward than we shoud the reverse the anchor. Now focus depends where move the selection direction this is correct, but the anchor position on first word selection on desktop this should not be locked.

Could not expand selection beyond non alphanumeric characters for example dots or commas.

word boundaries on double click should be respected. The punctionuation should not selected.

Could not expand selection beyond non alpha characters for example dots or commas. This happens with ctrl + arrow left and right.

Can not expand the selection using ctrl + shift + arrow left and right

when triple clicking on block for selection the cursor is not at the end of the block.

when triple clicking at two lines or more block the cursor is not rendered. It is rendered at the at beginning of the block and not the end of the block.

when moving with arrows keys the selection is not reseted if we do not have shift key pressed. Same thing with ctrl + arrows keys.

when selection going outside the screen the viewport should follow the selection.

when clicking on the sides or outside the editor we should reset the selection.

whe the whole window loses focus we need to render selection boxes with different color.

if click outside the box selection should be lost.

implement ctrl + A to select all text.

when selecting one word and typing, the word is not replaced

when selecting one word and deleting, the word is not deleted.when selecting entire block and typing, the block is not replaced

when selecting entire block and deleting, the block is not deleted

Fix word boundary selection logic, it should not include punction and speical signs

selection on empty lines not working in some cases.

arrow up and arrow down skip lines and go for the blocks instead of going line by line.

when selection is active and we click arrow up or left then the cursot should go back to start of the selection.

max selection dragging scroll speed should not be limited. Or limted but very large number. Because we don not how large the document could be.

empty line and selection drag

Cursor reverted to back of the page for some reason



Keyboard & Shortcuts

shortcuts does not work in other lang layouts.

ctrl + delete like vscode should work.

implement ctrl + C to copy text and ctrl + V to paste text (with HTML formatting) and ctrl + Shift + V to paste as plain text.

implement ctrl + X to cut text.

ctrl + b should work in the editor.

Add support for windows ctrl + Y and make sure the shortcuts are intuitiave for all opearting systems.

page up and page down should be implemented.

page up and down, home and end no longer working

CTRL + F

CTRL + S to save the conntent as markdown.

page up and down should work with visual blocks.



RTL & Internationalization

Arabic and other langs from rtl should be rendered from right to left.

left and right arrow keys should move correctly with rtl. Now while moving from ltr to rtl bloks work. But there is an issue if we start from rtl block

rtl should work with lists

rtl inline format rendering edge cases

arabic script stopped working after impelemting crdt

arabic text not breaking correcttly

selection drag rtl is broken

indent with mixed direction rtl todo

select arabic text and arrow left/right does not work as expected.

add tranlsation keys



Composition & IME

composition and other input methods such as IME should work.

mandrians characters are not working with with selection.

compoition characters are still left in viewport but composition is cancelled.

composition toolbar is in wrong place.

if we are composing at end of line than compoistion toolbar is stays same place this is worng.

in extermly long word that could not possible exist contactenated with composition than the compositon breaks in wrong way.

chiense text are not wrapping correctly

when compostion is on and delete we delete it delete behind the composition.

word navigation (Ctrl+Arrow) and selection (Ctrl+Shift+Arrow, double-click)

Undo/redo is broken on composition

Navigation with arrow keys (home,end,page up and down too)during composition is broken

on rtl left compositon in not underlined

one delete on mobile keyboard does cancel the compositon

Very long composition text does not break correcly, like if do not accept compositon and do it in batch.

start composition and unfocus the page does not cancel compositon.

word count does not work with CJK letters

Composition state cleanup on error

Can not use arrow when compositon active.



Inline Formatting & Styles

When editing a block the inline styles disappearing

add logic for for writing tracking markdown inlines styles.

inserting charaters after inline style creates new inlines objects instead of add to the existing block.

when pressing enter on end of heading then we should create new paragraph not heading.

when writing withing headers the text is converted to paragraphs for some reason.

ending with "backtick" not wokring

Clearing one letter, clears everything in format span

format span accumlation

Combination of bold and italic did not work one time.

Typing double space should clear fomrating or may do it by context menu

strike through should follow same color as text



Links

add link for inline rendering format but the styles should be resvered for links. Add parsing logic for links as well. Add menu for changing the link tile.

ctrl click or command click should open the link. But it should not matter if it happens in fly while selecting.

hover on link should radix toolip and preview and with edit edit button and copy button. clicking on link preview should open it.

how to do the above on mobile.

on hovering on a link near the edge, than the tooltip should be fully visible.

link menu should not appear on context menu

scrolling down while we have link overlay does not hide it.

link overlay not rendering correcty

Add way to add link on desktop

Pasting link should make link after we typing space

Pressing enter before link should not make the link disapears.



Block Operations

split function does not preserve block type.

list split at the end not creating new item.

Fix reading empty file, should at least be one block

backspace deletion on empty line that has heading after clear the styling.

implement "/" functionality to open command palette.

escaping slash menu does not work.

add unorded list block

add orded list block

add todo list block

hover on checkbox should be pointer

click on checkbox no longer working

delete at start of text after an image, delete the text.

intermidate state in todo list

Sequential numbered list not working with indents.

Quote block

code block

maths code block

can not undo clear list item operation

typing letters that conlicde with markdown serlization should be escaped

too many functions the loops all the blocks.

genreatic get block at positons



Images

add image blocks

clicking close to an image trigger upload menu. Clicking on image should persist it should not activate upload menu if we are pointer inside the image.

rendering cover image artifcat. The image has border

Rendering image has supper low resolution. Even though uploaded image is good

upload menu should be fixed in one place. If being clicked repeadly on upload image menu should not move.

i need to click two times outside to close image upload menu.

click outside the editor does not close the image upload menu or context menu.

on hover on image we should show the button for swapping image.

cache image response if it fails now it requests again and again

can not scroll when if image is a placeholder

we should be select an image.

Image should be selectable. We should be able to select an image.

going arrow left on start of text block that has image behind should select the iamge. Right arrow should work the same.

arrow up on image should create new text block.

image place holder should much smaller in the height

image on the edge is bit higher than the normal images

image cover bleeding on top edge stopped working

If we create new block before image and or after image and it not used we move down, the we should delete it.

should not image drag more than its container.

drag the images.

when click outside the image we should lose focus

conflict between scroll bar and drag handle.

placeholder image should drag handles.

word count should not count images.

copy and paste should work with images.

tapping under image that has no other blocks under should create new text block.

draging image handle and scrolling should work too.

hide editimagepopover on mobile

change position of cover image.

Remove an image. Improve EditImagePopover.

upload menu should be fixed in one place. If being clicked repeadly on upload image menu should not move.

context menu options on image are meaningless

should we embed images?

Image talking long time to upload/load



Clipboard (Copy/Paste)

improve pasting behivour and allow better clipboard content parsing.

copy not copying inline formating

pasting is not invalidating blocked cached height.

pasting into another text field such as title text field it is not working.

pasting images from webpages should handle images.

crdt pasting docoumet paste only first block

Remove the markdown style when copying plain text.

pasting lists (ul/ol) should preserve list structure and convert to list blocks

copying to do list block copys as markdown.

Pasting from screenshot does not work.



Undo/Redo

group undo and redo to words.

Group snapshots

wehn deleting a block and undoing it merges them



Scrolling & Viewport

if we scroll to the bottom of the page and then type Ctrl + A and delete the text, we should scroll to the top. But now we fall outside outside the viewport.

If i delete some text at the end of the document, the scroll size decraese, but the viewport does not update.

haptics on scrollbar. Improvement for scollbar.

scrollbar should not hit bottom porition on mobile (or at least on ios)

hide scrollbar when not scrolling

scrolling should not be active on locked mode

two finger scroll

Three-Finger Gestures

habtic on selecting scroll handle maybe.

undo or any edting opeartion should ensureCursor visible

Schedule tag should be hidden when scrolling.



Context Menu & Menus

If select all and right click the context menu disapears.

On desktop we should add formating inline options on cotnext menu.

one click on selection should trigger context menu.

focus issue on context menu

if there are mutliple formats should we close context menu directly on click on format sub menu?

I want drag context menu activation like native menu have.

start dag in editor padding and continue is not working really well.

could we use the natic context menu



Mobile (iOS & Android)

hold press and selecting down on mobile does not work correctly because cursor is not moving down.

when end edge scrolling we should open keyboard on mobile.

add select all on mobile.

consider adding selection dragging on mobiles on both anchor and foucus. Like it is on ios. This for epxanding the selection and shrinking.

on ios keyboard iland we should add active/inactive state for block type menu. External keyboard

on android keyboard toolbar we should add active/inactive state for block type menu.

we should add inline formatting options in ios keyboard island.

we should add inline formatting options in android keyboard toolbar.

context menu is direcly closing on mobile.

can not clear selection on moble if click outside or on top/bottom padding

select all on mobile not working really, i we already have selection on some block. It would select from start of that exisitng selectio until the end.

Android keyboard rendering stops after tap in selection - fixed by updating cursor position while preserving selection

drag thumb drag detection on mobile should have buffer area.

android toolbar is super broken.

scroll on pagearea is shard on mobile

clicking on other text inputs (sidebar, page title) should not show toolbar/keyboard island

editing issue on android. Can not edit text after selection.

on landscape oritentation the safe area taking to much and it is uncessary.

Safe area on sidebar

dynamic island hide buttons on iphone keyboard toolbar

dragging pages on mobile

I want to drag cursor. Solved by padding click.

ios block menu does not have same height as the keyboard.

could we disable edge navigation on andorid?

everything should suited for mobile, including flaoting menu.

checkbox click area should be bigger on mobile.

drag handles should be bigger on mobile.

word counter should be visible above the keyboard.

import and export not working on mobile

debug why toolbar disappear sometimes. constraints?

tapping at the end if pages does not select the end of a to do list.

remove this from url ?_update=1773188821023

Make sure to redirect back to app after resting password.



iOS App

ios top toolbar is too high under the os notification bar

ios keyboard island is always visibile if for normal text inputs

on deploy ios blacking out

override webiew defautl 404 page

opening emojis in event preveiw have bad ui effect.



Sidebar & Page Navigation

bring back the old tree code from l4r for saving pages and sort them into trees.

Tree page not working as it was in l4r˝

when openign or creating a page we should focus on page.

opening or creating page on mobile should close floaty sidebar.

when deleting current page we should close the current page.

scrolling on sidebar misread the scrolling with dragging.

title not updating in sidebar when triggering auto update.

Hover on buttons for pagelink that active should have better style

dawers should have scroll

Continue improving sidebar and pagelink

Flaoting sidebar should be suited flr mobile

Can not drop a page on thrid level or more

Optimistics updates in tree structure

Large bottom badding when opening a page tha has children.

sidebar safe area

canvas safe area

Save open pages to localstorage in good structure

Page is a task is considred having children



UI & Styling

add three dots right of saving the opens drawer for page settings.

change the font family in page settings

add word count if enabled in setings.

top bar is not same color

updating tile twichs a litle

updating title of parent should breadcrum

confirmation dialog when leaving page is reversed.

Add more animations to make the app more visually apealing.

do design overhaul.

Maybe specify how large of document we should supprt.

should placeholder be visible on out of focus?

when there is a selection we should count the selection word count not the whole document.

action bar options should only visible on editor page

theme not refelecting dirreclty after we choose system theme on mobile.

Checkbox square should be bit brighter on dark mode for contrast.

increase font size for people who wants it. Use rem

Collberatives cursors cutoff because i reduced the padding

Sidebar content area should have bottom padding

Drawer should not disapear if it have changes.

Sidebar if resize is not set and we hover on a page than than the sidebar expands in width.

Search box should disapear once it losses fous. Is this actaully good pratice. Escape should work as well anywhere.

Avatar resize, preview and crop.

Schedule tag should be repositioned when ther is an cover borderlesss image (or restyled).

Drag image to a page.



CRDT & Sync & Collaberation

tapping enter to split blocks does not not work well with crdt opreations.

when typing in the middle the other tab insert to the end.

remote caret should not be showen when there is selection.

remote caret should have name tag

remote selection should be seen in visual blocks

we should show blobs of remote users in topactionbar

fix stoarge problems with crdt

change content should reculate hights/documentb height in

on load document there is not scrollbar

1. Fix IDs

2. chair squashing

2. op chain

We should brodacast page delete

reload on disconencted the operations are lost.

close connections gracefully on app close

Interleaving on Concurrent Inserts

Short Peer IDs

tombstone pruning

3. Binary encoding

4. Delta compression

Consolidate @apps/web/src/sync/index.ts operations more

peforamnce issues after crdt

do we have unccessary long ids in snapshot

broadcast new update

Collaberation and websockets connection need to be much more stable and need awerness.



API & Backend

When loading a page first. it is overrideing the page with empty state. The update endpoint is being called before the page is loaded and is overriding with empty string

Database Operations Table

Read title from document

offline support maybe api backend in service workers so we can for example update titles

loading page is slow

loading apge should show spinner.

test users and test functions

improve websockets to handle more events.

We lose data sometimes! Is it because lf bad network connetion.

All listed pages are not available offline, how should we fix it?

test native storage.



Auth

Add button to show password EyeIcon

EyeIcon should be larger.

Multi users acconts.



Snapshots

snapshotting

snapshot restore

why snapshot have hlc clock

add snapshot previewing

No scroll bar in sapshots

The images have drag handle in snapshot previw

Test restore snapshot on new approach (local first approach)  



Serialization & Data

saving indictor loads for ever when editing offline.

invalidate cache when changing font.

i can still type when there is no focus

memory leak somehow the old state being presisted on hot reloading.

export/import features

protocol for opening cypher links.

If close the page sometimes we do not getconfimration dialog, maybe on bad network.

Update dialog show up without a reason sometimes.



Drag & Drop

dragging and dropping pagelink on same position it swaps position withe the one under.

dragging text

dragging blocks



Input Devices

Pen input, stylus support. Handwriting.

voice input/speeh-to-text

Accessiblity input?

Autorcorrect/autocomplete



Search & Navigation

Search functioanllity

Onboarding

Opening cypher.md loads no "pages found".

Creating calendar accross devices does not sync



Schedule (Calendar Features)

/new keyword for new event/page

Change placeholder to event in calender event

Typing p while editing an event goes foward in the calendar,

Cant not change event duration

Export should have schedule meta data

Schedule tag should have convert task maybe, if it is leaf page.

Show the pages/tasks connect to a page on delete

Close sidebar should close event preview

Clicking out of event preview it should close the preview

Can not sechedule an event longer than 8 hours in mobile.

Date time picker should change timezone according to date (dst)

Calendar zoom out and in.

Mutli drag and delete and move.

Page\event attachemts attachements.

Duplicate event ctrl drag.

Context menu on menu

Select mobile



Command Palette

We should be able to navigate page with cmd + k

Color on command palalte pages.



Search box

Ctlr + f should work eveywhere when edtior page is active.

Highlight on scroll bar.



Style

Change font serif font to one that suites the platforms

Breadcrumb on event