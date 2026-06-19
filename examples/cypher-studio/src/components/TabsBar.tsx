import { FolderOutline, GraphIcon, GridIcon, PlayIcon, SearchIcon } from "./icons";

export function TabsBar() {
  return (
    <div className="tabsbar">
      <div className="tabsbar__tools">
        <span className="tabsbar__tool">
          <FolderOutline />
        </span>
        <span className="tabsbar__tool">
          <SearchIcon />
        </span>
        <span className="tabsbar__tool">
          <GraphIcon />
        </span>
        <span className="tabsbar__tool">
          <PlayIcon />
        </span>
        <span className="tabsbar__tool">
          <GridIcon />
        </span>
      </div>
      <div className="tabsbar__tabs">
        <div className="tabsbar__tab tabsbar__tab--active">
          <span className="tabsbar__ext">md</span>
          README.md
          <span className="tabsbar__close">×</span>
        </div>
        <div className="tabsbar__tab">
          <span className="tabsbar__ext tabsbar__ext--dim">md</span>
          architecture.md
        </div>
      </div>
    </div>
  );
}
