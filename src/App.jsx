import { useState, useCallback, useEffect } from "react";

const REDIRECT_URI = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";
const SCOPES = "playlist-read-private playlist-read-collaborative";

// PKCE helpers
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function getSpotifyAuthUrl(clientId) {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("spotify_client_id", clientId);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCodeForToken(code, clientId, verifier) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error("Token exchange failed");
  return res.json();
}

function extractPlaylistId(input) {
  const patterns = [
    /spotify:playlist:([a-zA-Z0-9]+)/,
    /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/,
    /^([a-zA-Z0-9]{22})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function buildBeatportUrl(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return `https://www.beatport.com/search?q=${q}`;
}

async function fetchAllPlaylistTracks(token, playlistId) {
  let tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(name,artists(name),album(images),external_urls))`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);
    const data = await res.json();
    tracks = tracks.concat(data.items.filter((i) => i.track));
    url = data.next;
  }
  return tracks;
}

async function fetchPlaylistMeta(token, playlistId) {
  const res = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,description,images,owner(display_name),tracks(total)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Could not fetch playlist: ${res.status}`);
  return res.json();
}

const statusColors = { idle: "#555", found: "#00e5a0", notfound: "#ff4d6d", loading: "#ffcc00" };

export default function App() {
  const [clientId, setClientId] = useState(() => sessionStorage.getItem("spotify_client_id") || "");
  const [token, setToken] = useState(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlist, setPlaylist] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchStatus, setSearchStatus] = useState({});
  const [filter, setFilter] = useState("all");
  const [authLoading, setAuthLoading] = useState(false);

  // Handle OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const verifier = sessionStorage.getItem("pkce_verifier");
    const storedClientId = sessionStorage.getItem("spotify_client_id");
    if (code && verifier && storedClientId) {
      setAuthLoading(true);
      exchangeCodeForToken(code, storedClientId, verifier)
        .then((data) => {
          setToken(data.access_token);
          setClientId(storedClientId);
          sessionStorage.removeItem("pkce_verifier");
          window.history.replaceState({}, "", window.location.pathname);
        })
        .catch((e) => setError(e.message))
        .finally(() => setAuthLoading(false));
    }
  }, []);

  const handleAuth = async () => {
    if (!clientId.trim()) { setError("Enter your Spotify Client ID first."); return; }
    setError("");
    const url = await getSpotifyAuthUrl(clientId.trim());
    window.location.href = url;
  };

  const handleFetch = useCallback(async () => {
    setError(""); setTracks([]); setPlaylist(null);
    const id = extractPlaylistId(playlistUrl.trim());
    if (!id) { setError("Couldn't parse a playlist ID from that URL."); return; }
    setLoading(true);
    try {
      const [meta, items] = await Promise.all([
        fetchPlaylistMeta(token, id),
        fetchAllPlaylistTracks(token, id),
      ]);
      setPlaylist(meta);
      setTracks(items);
      const initStatus = {};
      items.forEach((_, i) => (initStatus[i] = "idle"));
      setSearchStatus(initStatus);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, playlistUrl]);

  const openBeatport = (idx, artist, title) => {
    window.open(buildBeatportUrl(artist, title), "_blank");
    setSearchStatus((s) => ({ ...s, [idx]: "found" }));
  };

  const openAll = () => {
    tracks.forEach((item, i) => {
      const artist = item.track.artists.map((a) => a.name).join(", ");
      setTimeout(() => {
        window.open(buildBeatportUrl(artist, item.track.name), "_blank");
        setSearchStatus((s) => ({ ...s, [i]: "found" }));
      }, i * 300);
    });
  };

  const filteredTracks = tracks.filter((_, i) => {
    if (filter === "all") return true;
    if (filter === "unsearched") return searchStatus[i] === "idle";
    if (filter === "searched") return searchStatus[i] === "found";
    return true;
  });

  const searchedCount = Object.values(searchStatus).filter((v) => v === "found").length;

  if (authLoading) return (
    <div style={{...styles.root, display:"flex", alignItems:"center", justifyContent:"center"}}>
      <div style={styles.grain}/>
      <p style={{fontFamily:"'DM Mono',monospace", color:"#00e5a0", letterSpacing:"0.1em"}}>Connecting to Spotify…</p>
    </div>
  );

  return (
    <div style={styles.root}>
      <div style={styles.grain} />
      <div style={styles.container}>
        <header style={styles.header}>
          <div style={styles.logoRow}>
            <span style={styles.logoIcon}>◈</span>
            <h1 style={styles.title}>CRATE<span style={styles.titleAccent}>BRIDGE</span></h1>
          </div>
          <p style={styles.subtitle}>Spotify playlist → Beatport search engine</p>
        </header>

        {!token ? (
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Connect Spotify</h2>
            <p style={styles.cardDesc}>
              You need a free Spotify Developer app to use this tool.{" "}
              <a href="https://developer.spotify.com/dashboard" target="_blank" style={styles.link}>
                Create one here
              </a>{" "}
              — set the Redirect URI to <strong style={{color:"#00e5a0"}}>{REDIRECT_URI}</strong>, then paste your Client ID below.
            </p>
            <div style={styles.inputRow}>
              <input
                style={styles.input}
                placeholder="Spotify Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAuth()}
              />
              <button style={styles.btn} onClick={handleAuth}>Authorize →</button>
            </div>
            {error && <p style={styles.error}>{error}</p>}
          </div>
        ) : (
          <>
            <div style={styles.card}>
              <h2 style={styles.cardTitle}>Load Playlist</h2>
              <div style={styles.inputRow}>
                <input
                  style={styles.input}
                  placeholder="Paste Spotify playlist URL or ID"
                  value={playlistUrl}
                  onChange={(e) => setPlaylistUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleFetch()}
                />
                <button style={styles.btn} onClick={handleFetch} disabled={loading}>
                  {loading ? "Loading…" : "Fetch →"}
                </button>
              </div>
              {error && <p style={styles.error}>{error}</p>}
            </div>

            {playlist && (
              <div style={styles.playlistMeta}>
                {playlist.images?.[0] && <img src={playlist.images[0].url} style={styles.playlistArt} alt="cover" />}
                <div>
                  <div style={styles.playlistName}>{playlist.name}</div>
                  <div style={styles.playlistSub}>{playlist.owner?.display_name} · {playlist.tracks?.total} tracks</div>
                  <div style={styles.progressRow}>
                    <div style={styles.progressBar}>
                      <div style={{...styles.progressFill, width: tracks.length ? `${(searchedCount/tracks.length)*100}%` : "0%"}} />
                    </div>
                    <span style={styles.progressLabel}>{searchedCount}/{tracks.length} searched</span>
                  </div>
                </div>
              </div>
            )}

            {tracks.length > 0 && (
              <div style={styles.controls}>
                <div style={styles.filterRow}>
                  {["all","unsearched","searched"].map((f) => (
                    <button key={f} style={{...styles.filterBtn,...(filter===f?styles.filterBtnActive:{})}} onClick={() => setFilter(f)}>{f}</button>
                  ))}
                </div>
                <button style={styles.openAllBtn} onClick={openAll}>⚡ Open All in Beatport</button>
              </div>
            )}

            {filteredTracks.length > 0 && (
              <div style={styles.trackList}>
                {filteredTracks.map((item, visIdx) => {
                  const realIdx = tracks.indexOf(item);
                  const track = item.track;
                  const artist = track.artists.map((a) => a.name).join(", ");
                  const img = track.album?.images?.[2]?.url || track.album?.images?.[0]?.url;
                  const status = searchStatus[realIdx] || "idle";
                  return (
                    <div key={realIdx} style={{...styles.trackRow, borderLeftColor: statusColors[status], animationDelay:`${visIdx*0.03}s`}}>
                      <div style={styles.trackLeft}>
                        {img && <img src={img} style={styles.trackThumb} alt="" />}
                        <div style={styles.trackInfo}>
                          <div style={styles.trackTitle}>{track.name}</div>
                          <div style={styles.trackArtist}>{artist}</div>
                        </div>
                      </div>
                      <div style={styles.trackActions}>
                        <div style={{...styles.statusDot, background: statusColors[status]}} />
                        <button style={styles.searchBtn} onClick={() => openBeatport(realIdx, artist, track.name)}>
                          Search Beatport →
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {tracks.length > 0 && filteredTracks.length === 0 && (
              <div style={styles.emptyState}>All tracks in this filter have been handled.</div>
            )}

            <button style={styles.logoutBtn} onClick={() => { setToken(null); setTracks([]); setPlaylist(null); }}>
              Disconnect
            </button>
          </>
        )}

        <footer style={styles.footer}>Beatport links open as searches — no official Beatport API is used.</footer>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&display=swap');
        @keyframes fadeSlideIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        * { box-sizing:border-box; margin:0; padding:0; }
        body { background:#0a0a0a; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:#111; }
        ::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
      `}</style>
    </div>
  );
}

const styles = {
  root: { minHeight:"100vh", background:"#0a0a0a", color:"#e8e8e8", fontFamily:"'DM Mono',monospace", position:"relative", overflow:"hidden" },
  grain: { position:"fixed", inset:0, backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")`, pointerEvents:"none", zIndex:0 },
  container: { maxWidth:760, margin:"0 auto", padding:"40px 20px 80px", position:"relative", zIndex:1 },
  header: { marginBottom:40 },
  logoRow: { display:"flex", alignItems:"center", gap:12, marginBottom:6 },
  logoIcon: { fontSize:28, color:"#00e5a0", lineHeight:1 },
  title: { fontFamily:"'Bebas Neue',sans-serif", fontSize:48, letterSpacing:"0.08em", color:"#f0f0f0", lineHeight:1 },
  titleAccent: { color:"#00e5a0" },
  subtitle: { fontSize:11, color:"#555", letterSpacing:"0.15em", textTransform:"uppercase", paddingLeft:40 },
  card: { background:"#111", border:"1px solid #1e1e1e", borderRadius:4, padding:24, marginBottom:16 },
  cardTitle: { fontFamily:"'Bebas Neue',sans-serif", fontSize:22, letterSpacing:"0.1em", color:"#ccc", marginBottom:10 },
  cardDesc: { fontSize:12, color:"#666", lineHeight:1.7, marginBottom:16 },
  link: { color:"#00e5a0", textDecoration:"none" },
  inputRow: { display:"flex", gap:8 },
  input: { flex:1, background:"#0d0d0d", border:"1px solid #2a2a2a", borderRadius:3, color:"#e0e0e0", fontSize:12, padding:"10px 14px", fontFamily:"'DM Mono',monospace", outline:"none" },
  btn: { background:"#00e5a0", color:"#000", border:"none", borderRadius:3, padding:"10px 18px", fontSize:12, fontFamily:"'DM Mono',monospace", fontWeight:500, cursor:"pointer", whiteSpace:"nowrap", letterSpacing:"0.05em" },
  error: { color:"#ff4d6d", fontSize:11, marginTop:10, letterSpacing:"0.05em" },
  playlistMeta: { display:"flex", gap:16, alignItems:"center", background:"#111", border:"1px solid #1e1e1e", borderRadius:4, padding:16, marginBottom:16 },
  playlistArt: { width:64, height:64, borderRadius:3, objectFit:"cover", flexShrink:0 },
  playlistName: { fontFamily:"'Bebas Neue',sans-serif", fontSize:22, letterSpacing:"0.06em", color:"#eee", marginBottom:2 },
  playlistSub: { fontSize:11, color:"#555", marginBottom:10 },
  progressRow: { display:"flex", alignItems:"center", gap:10 },
  progressBar: { width:160, height:3, background:"#222", borderRadius:2, overflow:"hidden" },
  progressFill: { height:"100%", background:"#00e5a0", borderRadius:2, transition:"width 0.4s ease" },
  progressLabel: { fontSize:10, color:"#555", letterSpacing:"0.08em" },
  controls: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, gap:12, flexWrap:"wrap" },
  filterRow: { display:"flex", gap:6 },
  filterBtn: { background:"transparent", border:"1px solid #2a2a2a", color:"#555", borderRadius:2, padding:"5px 12px", fontSize:10, fontFamily:"'DM Mono',monospace", cursor:"pointer", letterSpacing:"0.1em", textTransform:"uppercase" },
  filterBtnActive: { border:"1px solid #00e5a0", color:"#00e5a0" },
  openAllBtn: { background:"transparent", border:"1px solid #ff4d6d", color:"#ff4d6d", borderRadius:2, padding:"5px 14px", fontSize:10, fontFamily:"'DM Mono',monospace", cursor:"pointer", letterSpacing:"0.08em", textTransform:"uppercase" },
  trackList: { display:"flex", flexDirection:"column", gap:2 },
  trackRow: { display:"flex", alignItems:"center", justifyContent:"space-between", background:"#0f0f0f", border:"1px solid #1a1a1a", borderLeft:"3px solid #333", borderRadius:3, padding:"10px 14px", gap:12, animation:"fadeSlideIn 0.3s ease both" },
  trackLeft: { display:"flex", alignItems:"center", gap:12, overflow:"hidden" },
  trackThumb: { width:36, height:36, borderRadius:2, objectFit:"cover", flexShrink:0 },
  trackInfo: { overflow:"hidden" },
  trackTitle: { fontSize:12, color:"#ddd", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:340 },
  trackArtist: { fontSize:10, color:"#555", marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:340 },
  trackActions: { display:"flex", alignItems:"center", gap:10, flexShrink:0 },
  statusDot: { width:6, height:6, borderRadius:"50%", flexShrink:0, transition:"background 0.3s" },
  searchBtn: { background:"transparent", border:"1px solid #2a2a2a", color:"#888", borderRadius:2, padding:"4px 10px", fontSize:10, fontFamily:"'DM Mono',monospace", cursor:"pointer", letterSpacing:"0.06em", whiteSpace:"nowrap" },
  emptyState: { textAlign:"center", color:"#333", fontSize:11, padding:"40px 0", letterSpacing:"0.1em" },
  logoutBtn: { marginTop:32, background:"transparent", border:"1px solid #222", color:"#333", borderRadius:2, padding:"6px 14px", fontSize:10, fontFamily:"'DM Mono',monospace", cursor:"pointer", letterSpacing:"0.1em" },
  footer: { marginTop:48, fontSize:10, color:"#2a2a2a", textAlign:"center", letterSpacing:"0.1em" },
};
