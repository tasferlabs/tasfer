import { FolderSolid, SearchIcon } from "./icons";

export function FileTree() {
  return (
    <nav className="tree">
      <div className="tree__search">
        <SearchIcon size={15} />
        Search files…
      </div>

      <div className="tree__root">
        <span className="tree__caret">▾</span>DOCS-WORKSPACE
      </div>

      <div className="tree__list">
        <div className="tree__row tree__row--folder">
          <span className="tree__caret">▾</span>
          <FolderSolid color="#39c5cf" />
          docs
        </div>
        <div className="tree__row tree__row--nested">
          <span className="tree__ext">md</span>getting-started.md
        </div>
        <div className="tree__row tree__row--nested">
          <span className="tree__ext">md</span>architecture.md
        </div>
        <div className="tree__row tree__row--nested">
          <span className="tree__ext">md</span>theming.md
        </div>

        <div className="tree__row tree__row--folder">
          <span className="tree__caret">▾</span>
          <FolderSolid color="#e0b341" />
          assets
        </div>
        <div className="tree__row tree__row--nested">
          <span className="tree__ext tree__ext--dim">png</span>logo.png
        </div>
        <div className="tree__row tree__row--nested">
          <span className="tree__ext tree__ext--dim">svg</span>diagram.svg
        </div>

        <div className="tree__row tree__row--active">
          <span className="tree__ext">md</span>README.md
        </div>
        <div className="tree__row">
          <span className="tree__ext tree__ext--amber">{"{}"}</span>package.json
        </div>
        <div className="tree__row">
          <span className="tree__ext tree__ext--dim">©</span>LICENSE
        </div>
      </div>
    </nav>
  );
}
