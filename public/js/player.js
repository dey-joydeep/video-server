const video = document.getElementById('v');
const moreList = document.getElementById('moreList');

function getId() {
    const u = new URL(location.href);
    return u.searchParams.get('id');
}

function bindKeys() {
    window.addEventListener('keydown', (e) => {
        if (
            ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(
                document.activeElement?.tagName
            )
        )
            return;
        if (e.key === ' ') {
            e.preventDefault();
            video.paused ? video.play() : video.pause();
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            video.currentTime = Math.min(
                video.duration || 1,
                video.currentTime + 5
            );
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            video.currentTime = Math.max(0, video.currentTime - 5);
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            video.volume = Math.min(1, (video.volume || 0) + 0.05);
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            video.volume = Math.max(0, (video.volume || 0) - 0.05);
        }
    });
}

async function play(id) {
    const res = await fetch('/api/session?id=' + encodeURIComponent(id));
    if (!res.ok) {
        alert('Failed to start session');
        return;
    }
    const { hlsUrl } = await res.json();

    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('controlslist', 'noplaybackrate nodownload');

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        await video.play().catch(() => {});
    } else if (window.Hls && window.Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: false });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
    } else {
        alert('Your browser cannot play secure HLS.');
    }
}

async function loadMoreList(excludeId) {
    const res = await fetch('/api/list?limit=1000&offset=0');
    const data = await res.json();
    const items = (data.items || data)
        .filter((x) => x.id !== excludeId)
        .slice(0, 14);
    moreList.innerHTML = items
        .map(
            (it) => `
    <div class="card" data-id="\${it.id}" data-name="\${it.name}" tabindex="0" role="button" aria-label="Open \${it.name}">
      <img class="thumb" src="/thumbs/\${it.thumb}" alt="\${it.name}">
      <div class="title">\${it.name}</div>
      <div class="meta">\${new Date(it.mtimeMs).toLocaleString()}</div>
    </div>`
        )
        .join('');

    moreList.querySelectorAll('.card').forEach((card) => {
        const open = () => {
            const nid = card.dataset.id;
            history.replaceState(
                null,
                '',
                './player.html?id=' + encodeURIComponent(nid)
            );
            play(nid);
            loadMoreList(nid);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });
    });
}

(async () => {
    const id = getId();
    if (!id) {
        alert('Missing id');
        return;
    }
    bindKeys();
    await play(id);
    await loadMoreList(id);
})();
