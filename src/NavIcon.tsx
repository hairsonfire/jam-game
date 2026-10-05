type Icon = "play" | "witness" | "music" | "dj" | "admin";

// SVG paths use one canvas and stroke, avoiding platform-dependent emoji glyphs.
export function NavIcon({ name }: { name: Icon }) {
  const paths: Record<Icon, React.ReactNode> = {
    play: <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z" />,
    witness: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /></>,
    music: <><path d="M9 18V5l11-2v13M9 9l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2.5" /><ellipse cx="17" cy="16" rx="3" ry="2.5" /></>,
    dj: <><path d="M5 3v18M12 3v18M19 3v18" /><path d="M2 8h6M9 16h6M16 8h6" /></>,
    admin: <><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 3 3-1 2 3 3-1 1-3 3-1 2-3-2-2 1-3-3-3-3 1-2-3Z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
