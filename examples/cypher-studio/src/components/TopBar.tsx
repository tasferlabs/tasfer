const MENUS = ["File", "Edit", "View", "Go", "Window", "Help"];

export function TopBar() {
  return (
    <div className="topbar">
      <div className="topbar__brand">
        <span className="topbar__logo">✦</span>
        <span className="topbar__name">Cypher Studio</span>
      </div>
      <div className="topbar__menus">
        {MENUS.map((m) => (
          <span key={m} className="topbar__menu">
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}
