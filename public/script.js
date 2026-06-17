// ============================================================
// SOUNDIFY - SCRIPT.JS (FULL + MEDIA SESSION + PERSISTENT)
// ============================================================

// --- 0. NAVIGASI BACK, SPLASH SCREEN & PWA AUTO-UPDATE ---
window.addEventListener('load', function() {
    history.replaceState({ view: 'home' }, '', '#home');

    if (!sessionStorage.getItem('splashShown')) {
        setTimeout(function() {
            var splash = document.getElementById('splash-screen');
            if(splash) {
                splash.style.opacity = '0';
                setTimeout(function() { 
                    splash.style.display = 'none'; 
                    splash.remove(); 
                }, 500);
            }
        }, 7500);
        sessionStorage.setItem('splashShown', 'true');
    } else {
        var splash = document.getElementById('splash-screen');
        if(splash) {
            splash.style.display = 'none';
            splash.remove();
        }
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(function(reg) {
            reg.update();
        }).catch(function(err) { console.log('PWA error:', err); });

        var refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', function() {
            if (!refreshing) {
                refreshing = true;
                window.location.reload(); 
            }
        });
    }
    
    loadHomeData();
    renderSearchCategories();
    injectPersistentPlayerHTML();
    setupMediaSession();
});

var deferredPrompt;
window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault(); 
    deferredPrompt = e;
    
    var installBtn = document.getElementById('installAppBtn');
    if(installBtn) {
        installBtn.style.display = 'flex'; 
        installBtn.addEventListener('click', async function() {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                var result = await deferredPrompt.userChoice;
                if(result.outcome === 'accepted') installBtn.style.display = 'none'; 
                deferredPrompt = null;
            }
        });
    }
});

window.addEventListener('appinstalled', function() {
    var installBtn = document.getElementById('installAppBtn');
    if(installBtn) installBtn.style.display = 'none';
    deferredPrompt = null;
});

window.addEventListener('popstate', function(e) {
    if (e.state && e.state.view) {
        switchView(e.state.view, false);
    } else {
        switchView('home', false);
    }
});

// --- 1. INDEXEDDB SETUP ---
var db;
var request = indexedDB.open("SannMusicDB", 2);
request.onupgradeneeded = function(e) {
    db = e.target.result;
    if(!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    if(!db.objectStoreNames.contains('liked_songs')) db.createObjectStore('liked_songs', { keyPath: 'videoId' });
    if(!db.objectStoreNames.contains('favorite_songs')) db.createObjectStore('favorite_songs', { keyPath: 'videoId' });
    if(!db.objectStoreNames.contains('history_songs')) db.createObjectStore('history_songs', { keyPath: 'timestamp' });
    if(!db.objectStoreNames.contains('offline_songs')) db.createObjectStore('offline_songs', { keyPath: 'videoId' });
};
request.onsuccess = function(e) { db = e.target.result; renderLibraryUI(); };

// --- 2. GLOBAL VARIABLES ---
var ytPlayer;
var isPlaying = false;
var currentTrack = null;
var progressInterval;

var isShuffle = false;
var repeatState = 0; 
var currentRepeatCount = 0;
var currentPlayContext = null; 
var sleepTimerTimeout = null;

var isEditMode = false;
var selectedTracksForDelete = new Set();

var persistentAudio = null;
var persistentSource = null;
var audioContext = null;

// --- 3. PERSISTENT PLAYER HTML INJECT ---
function injectPersistentPlayerHTML() {
    if (document.getElementById('persistentMiniPlayer')) return;
    
    var miniHTML = `
    <div id="persistentMiniPlayer">
        <img id="miniCover" class="mini-cover" src="" alt="cover">
        <div class="mini-info">
            <div class="mini-title" id="miniTitle">Judul Lagu</div>
            <div class="mini-artist" id="miniArtist">Artis</div>
        </div>
        <div class="mini-controls">
            <svg id="miniPrevBtn" onclick="event.stopPropagation(); prevTrackPersistent()" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            <div class="mini-play-btn" onclick="event.stopPropagation(); togglePlayPersistent()">
                <svg id="miniPlayIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
            <svg id="miniNextBtn" onclick="event.stopPropagation(); nextTrackPersistent()" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            <svg onclick="event.stopPropagation(); openPictureInPicture()" viewBox="0 0 24 24" style="fill:white; width:20px; height:20px; cursor:pointer;">
                <path d="M19 7h-8v6h8V7zm-2 4h-4V9h4v2zm4-8H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/>
            </svg>
        </div>
        <div class="mini-progress-track">
            <div id="miniProgressFill" class="mini-progress-fill"></div>
        </div>
    </div>
    `;

    var fullscreenHTML = `
    <div id="fullscreenPlayerModal">
        <button class="fs-close" onclick="closeFullscreenPlayer()">X</button>
        <img id="fsCover" class="fs-cover" src="" alt="cover">
        <div class="fs-info">
            <div class="fs-title" id="fsTitle">Judul Lagu</div>
            <div class="fs-artist" id="fsArtist">Artis</div>
        </div>
        <div class="fs-progress">
            <input type="range" id="fsProgressBar" min="0" max="100" value="0" step="1" oninput="seekToPersistent(this.value)">
        </div>
        <div class="fs-time">
            <span id="fsCurrentTime">0:00</span>
            <span id="fsTotalTime">0:00</span>
        </div>
        <div class="fs-controls">
            <svg onclick="toggleShufflePersistent()" viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
            <svg onclick="prevTrackPersistent()" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            <div class="fs-play-btn" onclick="togglePlayPersistent()">
                <svg id="fsPlayIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </div>
            <svg onclick="nextTrackPersistent()" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            <svg onclick="toggleRepeatPersistent()" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
        </div>
        <div style="color:#b3b3b3; font-size:12px; margin-top:16px; text-align:center;" id="fsDurationInfo">0:00 / 0:00</div>
    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', miniHTML);
    document.body.insertAdjacentHTML('beforeend', fullscreenHTML);
    
    document.addEventListener('click', function(e) {
        var mini = document.getElementById('persistentMiniPlayer');
        if (mini && mini.contains(e.target) && !e.target.closest('.mini-controls') && !e.target.closest('.mini-play-btn')) {
            openFullscreenPlayer();
        }
    });
}

// --- 4. PERSISTENT PLAYER LOGIC ---
var persistentTrack = {
    title: '',
    artist: '',
    cover: '',
    url: '',
    duration: 0,
    isPlaying: false,
    audio: null,
    queue: [],
    queueIndex: 0,
    shuffle: false,
    repeat: false
};

function showPersistentPlayer(track) {
    var mini = document.getElementById('persistentMiniPlayer');
    if (!mini) {
        injectPersistentPlayerHTML();
        setTimeout(function() { showPersistentPlayer(track); }, 100);
        return;
    }
    
    var coverImg = track.cover || track.img || 'https://placehold.co/48x48/282828/FFFFFF?text=Music';
    document.getElementById('miniCover').src = coverImg;
    document.getElementById('miniTitle').textContent = track.title || 'Judul Lagu';
    document.getElementById('miniArtist').textContent = track.artist || 'Artis';
    
    document.getElementById('fsCover').src = coverImg;
    document.getElementById('fsTitle').textContent = track.title || 'Judul Lagu';
    document.getElementById('fsArtist').textContent = track.artist || 'Artis';
    
    persistentTrack.title = track.title;
    persistentTrack.artist = track.artist;
    persistentTrack.cover = coverImg;
    persistentTrack.url = track.url || track.videoId;
    persistentTrack.duration = track.duration || 0;
    
    if (persistentAudio) {
        persistentAudio.pause();
        persistentAudio = null;
    }
    
    if (track.audioUrl) {
        persistentAudio = new Audio(track.audioUrl);
        persistentAudio.volume = 0.8;
        persistentAudio.addEventListener('timeupdate', updatePersistentProgress);
        persistentAudio.addEventListener('ended', function() {
            nextTrackPersistent();
        });
        persistentAudio.addEventListener('loadedmetadata', function() {
            var dur = persistentAudio.duration;
            if (!isNaN(dur)) {
                persistentTrack.duration = dur;
                document.getElementById('fsTotalTime').textContent = formatTime(dur);
                document.getElementById('fsDurationInfo').textContent = '0:00 / ' + formatTime(dur);
            }
        });
        persistentAudio.play().then(function() {
            persistentTrack.isPlaying = true;
            updatePlayIcons(true);
            mini.style.display = 'flex';
            updateMediaSessionNow();
        }).catch(function() {
            if (ytPlayer && track.videoId) {
                ytPlayer.loadVideoById(track.videoId);
                mini.style.display = 'flex';
            }
        });
    } else if (ytPlayer && track.videoId) {
        ytPlayer.loadVideoById(track.videoId);
        mini.style.display = 'flex';
    }
    
    updateMediaSessionNow();
}

function togglePlayPersistent() {
    if (persistentAudio) {
        if (persistentTrack.isPlaying) {
            persistentAudio.pause();
        } else {
            persistentAudio.play().catch(function() {});
        }
        persistentTrack.isPlaying = !persistentTrack.isPlaying;
        updatePlayIcons(persistentTrack.isPlaying);
        updateMediaSessionNow();
    } else if (ytPlayer) {
        togglePlay();
    }
}

function updatePlayIcons(isPlaying) {
    var miniIcon = document.getElementById('miniPlayIcon');
    var fsIcon = document.getElementById('fsPlayIcon');
    var path = isPlaying ? '<path d="M6 4h4v16H6z M14 4h4v16h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    if (miniIcon) miniIcon.innerHTML = path;
    if (fsIcon) fsIcon.innerHTML = path;
}

function updatePersistentProgress() {
    if (persistentAudio) {
        var current = persistentAudio.currentTime;
        var duration = persistentAudio.duration || 1;
        var progress = (current / duration) * 100;
        
        document.getElementById('miniProgressFill').style.width = progress + '%';
        document.getElementById('fsProgressBar').value = progress;
        document.getElementById('fsCurrentTime').textContent = formatTime(current);
        document.getElementById('fsTotalTime').textContent = formatTime(duration);
        document.getElementById('fsDurationInfo').textContent = formatTime(current) + ' / ' + formatTime(duration);
    } else if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getDuration) {
        var current = ytPlayer.getCurrentTime();
        var duration = ytPlayer.getDuration();
        if (duration > 0) {
            var progress = (current / duration) * 100;
            document.getElementById('miniProgressFill').style.width = progress + '%';
            document.getElementById('fsProgressBar').value = progress;
            document.getElementById('fsCurrentTime').textContent = formatTime(current);
            document.getElementById('fsTotalTime').textContent = formatTime(duration);
            document.getElementById('fsDurationInfo').textContent = formatTime(current) + ' / ' + formatTime(duration);
        }
    }
}

function seekToPersistent(value) {
    if (persistentAudio) {
        var duration = persistentAudio.duration || 1;
        var seekTime = (value / 100) * duration;
        persistentAudio.currentTime = seekTime;
    } else if (ytPlayer) {
        seekTo(value);
    }
}

function closeFullscreenPlayer() {
    document.getElementById('fullscreenPlayerModal').style.display = 'none';
}

function openFullscreenPlayer() {
    var modal = document.getElementById('fullscreenPlayerModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('fsCover').src = document.getElementById('miniCover').src;
    document.getElementById('fsTitle').textContent = document.getElementById('miniTitle').textContent;
    document.getElementById('fsArtist').textContent = document.getElementById('miniArtist').textContent;
    updatePersistentProgress();
}

function prevTrackPersistent() {
    showToast('Lagu sebelumnya');
    if (currentPlayContext && currentPlayContext.data) {
        var idx = currentPlayContext.data.findIndex(function(t) { return t.videoId === currentTrack.videoId; });
        if (idx > 0) {
            var prev = currentPlayContext.data[idx - 1];
            var trackData = encodeURIComponent(JSON.stringify(prev)).replace(/'/g, "%27");
            playMusic(prev.videoId, trackData, currentPlayContext);
        }
    }
}

function nextTrackPersistent() {
    showToast('Lagu berikutnya');
    if (currentPlayContext && currentPlayContext.data) {
        var idx = currentPlayContext.data.findIndex(function(t) { return t.videoId === currentTrack.videoId; });
        if (idx !== -1 && idx + 1 < currentPlayContext.data.length) {
            var next = currentPlayContext.data[idx + 1];
            var trackData = encodeURIComponent(JSON.stringify(next)).replace(/'/g, "%27");
            playMusic(next.videoId, trackData, currentPlayContext);
        }
    }
}

function toggleShufflePersistent() {
    persistentTrack.shuffle = !persistentTrack.shuffle;
    showToast(persistentTrack.shuffle ? 'Shuffle ON' : 'Shuffle OFF');
}

function toggleRepeatPersistent() {
    persistentTrack.repeat = !persistentTrack.repeat;
    showToast(persistentTrack.repeat ? 'Repeat ON' : 'Repeat OFF');
}

// --- 5. PICTURE-IN-PICTURE ---
function openPictureInPicture() {
    if (!('pictureInPictureEnabled' in document)) {
        showToast('PiP tidak didukung browser ini');
        return;
    }
    
    var pipVideo = document.getElementById('pipVideo');
    if (!pipVideo) {
        pipVideo = document.createElement('video');
        pipVideo.id = 'pipVideo';
        pipVideo.style.display = 'none';
        pipVideo.muted = false;
        pipVideo.playsInline = true;
        document.body.appendChild(pipVideo);
    }
    
    if (persistentAudio && persistentAudio.src) {
        pipVideo.src = persistentAudio.src;
    } else if (currentTrack && currentTrack.videoId) {
        pipVideo.src = 'https://www.youtube.com/embed/' + currentTrack.videoId + '?autoplay=1';
    } else {
        showToast('Tidak ada audio untuk PiP');
        return;
    }
    
    pipVideo.requestPictureInPicture()
        .then(function() {
            showToast('PiP aktif');
            pipVideo.play().catch(function() {});
        })
        .catch(function(err) {
            showToast('PiP gagal: ' + err.message);
        });
}

// --- 6. MEDIA SESSION ---
function setupMediaSession() {
    if (!('mediaSession' in navigator)) {
        console.log('Media Session tidak didukung');
        return;
    }
    
    navigator.mediaSession.setActionHandler('play', function() {
        if (persistentAudio) {
            persistentAudio.play();
            persistentTrack.isPlaying = true;
            updatePlayIcons(true);
        } else if (ytPlayer) {
            ytPlayer.playVideo();
        }
        updateMediaSessionNow();
    });
    
    navigator.mediaSession.setActionHandler('pause', function() {
        if (persistentAudio) {
            persistentAudio.pause();
            persistentTrack.isPlaying = false;
            updatePlayIcons(false);
        } else if (ytPlayer) {
            ytPlayer.pauseVideo();
        }
        updateMediaSessionNow();
    });
    
    navigator.mediaSession.setActionHandler('nexttrack', function() {
        nextTrackPersistent();
    });
    
    navigator.mediaSession.setActionHandler('previoustrack', function() {
        prevTrackPersistent();
    });
    
    navigator.mediaSession.setActionHandler('stop', function() {
        if (persistentAudio) {
            persistentAudio.pause();
            persistentTrack.isPlaying = false;
            updatePlayIcons(false);
        }
        updateMediaSessionNow();
    });
    
    console.log('Media Session siap');
}

function updateMediaSessionNow() {
    if (!('mediaSession' in navigator)) return;
    
    var title = currentTrack && currentTrack.title ? currentTrack.title : (persistentTrack.title || 'Soundify');
    var artist = currentTrack && currentTrack.artist ? currentTrack.artist : (persistentTrack.artist || 'DooOffc');
    var cover = currentTrack && currentTrack.img ? currentTrack.img : (persistentTrack.cover || 'https://via.placeholder.com/512');
    
    navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: 'Soundify Music',
        artwork: [
            { src: cover, sizes: '512x512', type: 'image/png' },
            { src: cover, sizes: '192x192', type: 'image/png' }
        ]
    });
    
    var isCurrentlyPlaying = persistentTrack.isPlaying || isPlaying;
    navigator.mediaSession.playbackState = isCurrentlyPlaying ? 'playing' : 'paused';
}

// --- 7. YOUTUBE PLAYER ---
function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '0', width: '0',
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) { console.log('Player Ready'); }

function onPlayerStateChange(event) {
    var mainPlayBtn = document.getElementById('mainPlayBtn');
    var miniPlayBtn = document.getElementById('miniPlayBtn');
    var playIconPath = 'M8 5v14l11-7z';
    var pauseIconPath = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';

    if (event.data == YT.PlayerState.PLAYING) {
        isPlaying = true;
        persistentTrack.isPlaying = true;
        if (mainPlayBtn) mainPlayBtn.innerHTML = '<path d="' + pauseIconPath + '"></path>';
        if (miniPlayBtn) miniPlayBtn.innerHTML = '<path d="' + pauseIconPath + '"></path>';
        updatePlayIcons(true);
        startProgressBar();
        updateMediaSessionNow();
        
        var mini = document.getElementById('persistentMiniPlayer');
        if (mini && currentTrack) {
            mini.style.display = 'flex';
            document.getElementById('miniCover').src = currentTrack.img || 'https://placehold.co/48x48/282828/FFFFFF?text=Music';
            document.getElementById('miniTitle').textContent = currentTrack.title || 'Judul Lagu';
            document.getElementById('miniArtist').textContent = currentTrack.artist || 'Artis';
        }
    } else if (event.data == YT.PlayerState.PAUSED) {
        isPlaying = false;
        persistentTrack.isPlaying = false;
        if (mainPlayBtn) mainPlayBtn.innerHTML = '<path d="' + playIconPath + '"></path>';
        if (miniPlayBtn) miniPlayBtn.innerHTML = '<path d="' + playIconPath + '"></path>';
        updatePlayIcons(false);
        stopProgressBar();
        updateMediaSessionNow();
    } else if (event.data == YT.PlayerState.ENDED) {
        isPlaying = false;
        persistentTrack.isPlaying = false;
        if (mainPlayBtn) mainPlayBtn.innerHTML = '<path d="' + playIconPath + '"></path>';
        if (miniPlayBtn) miniPlayBtn.innerHTML = '<path d="' + playIconPath + '"></path>';
        updatePlayIcons(false);
        stopProgressBar();
        updateMediaSessionNow();
        handleTrackEnded();
    }
}

function handleTrackEnded() {
    if (repeatState === 1) {
        if (currentRepeatCount < 1) { currentRepeatCount++; ytPlayer.seekTo(0); ytPlayer.playVideo(); return; }
        else { currentRepeatCount = 0; }
    } else if (repeatState === 2) {
        if (currentRepeatCount < 3) { currentRepeatCount++; ytPlayer.seekTo(0); ytPlayer.playVideo(); return; }
        else { currentRepeatCount = 0; }
    } else if (repeatState === 3) {
        ytPlayer.seekTo(0); ytPlayer.playVideo(); return;
    }
    playNextTrack(false);
}

function playNextTrack(isManualClick) {
    if(isManualClick === undefined) isManualClick = true;
    if(isManualClick) currentRepeatCount = 0;

    if (currentPlayContext && currentPlayContext.data && currentPlayContext.data.length > 0) {
        if (isShuffle) {
            var randomIndex = Math.floor(Math.random() * currentPlayContext.data.length);
            var randomTrack = currentPlayContext.data[randomIndex];
            var trackData = encodeURIComponent(JSON.stringify(randomTrack)).replace(/'/g, "%27");
            playMusic(randomTrack.videoId, trackData, currentPlayContext);
        } else {
            var currentIndex = currentPlayContext.data.findIndex(function(t) { return t.videoId === currentTrack.videoId; });
            if (currentIndex !== -1 && currentIndex + 1 < currentPlayContext.data.length) {
                var nextTrack = currentPlayContext.data[currentIndex + 1];
                var trackData = encodeURIComponent(JSON.stringify(nextTrack)).replace(/'/g, "%27");
                playMusic(nextTrack.videoId, trackData, currentPlayContext);
            } else {
                playNextSimilarSong(); 
            }
        }
    } else {
        playNextSimilarSong();
    }
}

async function playNextSimilarSong() {
    if (!currentTrack) return;
    try {
        var response = await fetch('/api/search?query=' + encodeURIComponent(currentTrack.artist + ' official audio'));
        var result = await response.json();
        if (result.status === 'success' && result.data.length > 0) {
            var relatedSongs = result.data.filter(function(t) { return t.videoId !== currentTrack.videoId; });
            if (relatedSongs.length > 0) {
                var nextTrack = relatedSongs[Math.floor(Math.random() * relatedSongs.length)];
                var img = nextTrack.thumbnail ? nextTrack.thumbnail : (nextTrack.img ? nextTrack.img : 'https://placehold.co/140x140/282828/FFFFFF?text=Music');
                img = getHighResImage(img);
                var artist = nextTrack.artist ? nextTrack.artist : 'Unknown';
                var trackData = encodeURIComponent(JSON.stringify({videoId: nextTrack.videoId, title: nextTrack.title, artist: artist, img: img})).replace(/'/g, "%27");
                playMusic(nextTrack.videoId, trackData, null); 
            }
        }
    } catch (error) {}
}

function addToHistory(track) {
    if(!db) return;
    var tx = db.transaction('history_songs', 'readwrite');
    var store = tx.objectStore('history_songs');
    var newTrack = JSON.parse(JSON.stringify(track));
    newTrack.timestamp = Date.now();
    store.put(newTrack);
    
    var countReq = store.count();
    countReq.onsuccess = function() {
        if(countReq.result > 50) {
            var cursorReq = store.openCursor();
            cursorReq.onsuccess = function(e) {
                var cursor = e.target.result;
                if(cursor) { cursor.delete(); }
            };
        }
    };
}

function playMusic(videoId, encodedTrackData, contextData) {
    if(contextData === undefined) contextData = null;
    if(currentTrack && currentTrack.videoId !== videoId) currentRepeatCount = 0;
    
    currentTrack = JSON.parse(decodeURIComponent(encodedTrackData));
    currentPlayContext = contextData; 
    
    addToHistory(currentTrack);
    checkIfLiked(currentTrack.videoId);

    var mini = document.getElementById('persistentMiniPlayer');
    if (mini) {
        mini.style.display = 'flex';
        document.getElementById('miniCover').src = currentTrack.img || 'https://placehold.co/48x48/282828/FFFFFF?text=Music';
        document.getElementById('miniTitle').innerText = currentTrack.title || 'Judul Lagu';
        document.getElementById('miniArtist').innerText = currentTrack.artist || 'Artis';
    }

    document.getElementById('miniPlayer').style.display = 'flex';
    document.getElementById('miniPlayerImg').src = currentTrack.img;
    document.getElementById('miniPlayerTitle').innerText = currentTrack.title;
    document.getElementById('miniPlayerArtist').innerText = currentTrack.artist;

    document.getElementById('playerArt').src = currentTrack.img;
    document.getElementById('playerTitle').innerText = currentTrack.title;
    document.getElementById('playerArtist').innerText = currentTrack.artist;
    document.getElementById('playerBg').style.backgroundImage = 'url(' + currentTrack.img + ')';

    updateMediaSessionNow();

    if (ytPlayer && ytPlayer.loadVideoById) ytPlayer.loadVideoById(videoId);
    
    document.getElementById('progressBar').value = 0;
    document.getElementById('miniProgressBar').style.width = '0%';
    document.getElementById('currentTime').innerText = '0:00';
    document.getElementById('totalTime').innerText = '0:00';
}

function togglePlay() {
    if (!ytPlayer) return;
    if (isPlaying) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
}

function expandPlayer() { document.getElementById('playerModal').style.display = 'flex'; }
function minimizePlayer() { document.getElementById('playerModal').style.display = 'none'; }

function formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity || seconds < 0) return '0:00';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function startProgressBar() {
    stopProgressBar();
    progressInterval = setInterval(function() {
        if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getDuration) {
            var current = ytPlayer.getCurrentTime();
            var duration = ytPlayer.getDuration();
            if (duration > 0) {
                var percent = (current / duration) * 100;
                
                var progressBar = document.getElementById('progressBar');
                if (progressBar) {
                    progressBar.value = percent;
                    progressBar.style.background = 'linear-gradient(to right, white ' + percent + '%, rgba(255,255,255,0.2) ' + percent + '%)';
                }
                
                document.getElementById('miniProgressBar').style.width = percent + '%';
                document.getElementById('currentTime').innerText = formatTime(current);
                document.getElementById('totalTime').innerText = formatTime(duration);
            }
        }
        updatePersistentProgress();
    }, 1000);
}

function stopProgressBar() { clearInterval(progressInterval); }

function seekTo(value) {
    if (ytPlayer && ytPlayer.getDuration) {
        var duration = ytPlayer.getDuration();
        var seekTime = (value / 100) * duration;
        ytPlayer.seekTo(seekTime, true);
        var percent = value;
        document.getElementById('progressBar').style.background = 'linear-gradient(to right, white ' + percent + '%, rgba(255,255,255,0.2) ' + percent + '%)';
        document.getElementById('miniProgressBar').style.width = percent + '%';
    }
}

// --- SHUFFLE & REPEAT ---
function toggleShuffle() {
    isShuffle = !isShuffle;
    var btn1 = document.getElementById('btnShuffle');
    var btn2 = document.getElementById('btnPlaylistShuffle');
    var color = isShuffle ? '#1ed760' : 'var(--text-sub)';
    if (btn1) btn1.style.fill = color;
    if (btn2) btn2.style.fill = color;
    showToast(isShuffle ? 'Acak dihidupkan' : 'Acak dimatikan');
}

function toggleRepeat() {
    repeatState = (repeatState + 1) % 4;
    var btn = document.getElementById('btnRepeat');
    var badge = document.getElementById('repeatBadge');
    
    if (repeatState === 0) {
        if (btn) btn.style.fill = 'var(--text-sub)';
        if (badge) badge.style.display = 'none';
        showToast('Ulangi dimatikan');
    } else {
        if (btn) btn.style.fill = '#1ed760';
        if (badge) {
            badge.style.display = 'block';
            if (repeatState === 1) { badge.innerText = '1x'; showToast('Ulangi 1 kali'); }
            if (repeatState === 2) { badge.innerText = '3x'; showToast('Ulangi 3 kali'); }
            if (repeatState === 3) { badge.innerText = '8'; showToast('Ulangi terus'); }
        }
    }
}

// --- DOWNLOAD OFFLINE ---
function downloadCurrentTrack() {
    if(!currentTrack) return;
    showToast('Menyiapkan metadata lagu untuk offline...');
    var tx = db.transaction('offline_songs', 'readwrite');
    tx.objectStore('offline_songs').put(currentTrack);
    setTimeout(function() { showToast('Selesai! Tersedia di Unduhan'); renderLibraryUI(); }, 2000);
    closePlayerMenuModal();
}

function downloadCurrentPlaylist() {
    if(!currentPlaylistTracks || currentPlaylistTracks.length === 0) return;
    showToast('Menyiapkan ' + currentPlaylistTracks.length + ' lagu untuk offline...');
    var tx = db.transaction('offline_songs', 'readwrite');
    var store = tx.objectStore('offline_songs');
    currentPlaylistTracks.forEach(function(t) { store.put(t); });
    setTimeout(function() { showToast('Selesai! Tersedia di Unduhan'); renderLibraryUI(); }, 3000);
}

// --- MENU TITIK TIGA ---
function openPlayerMenuModal() {
    if(!currentTrack) return;
    document.getElementById('menuArt').src = currentTrack.img;
    document.getElementById('menuTitle').innerText = currentTrack.title;
    document.getElementById('menuArtist').innerText = currentTrack.artist;
    document.getElementById('playerMenuModal').style.display = 'flex';
}

function closePlayerMenuModal() { document.getElementById('playerMenuModal').style.display = 'none'; }

function setSleepTimer() {
    var minutes = prompt('Matikan musik otomatis dalam berapa menit?', '15');
    if(minutes != null && !isNaN(minutes) && minutes > 0) {
        if(sleepTimerTimeout) clearTimeout(sleepTimerTimeout);
        sleepTimerTimeout = setTimeout(function() {
            if(ytPlayer && isPlaying) ytPlayer.pauseVideo();
            if(persistentAudio && persistentTrack.isPlaying) {
                persistentAudio.pause();
                persistentTrack.isPlaying = false;
                updatePlayIcons(false);
            }
            showToast('Musik dimatikan (Sleep Timer)');
            updateMediaSessionNow();
        }, minutes * 60000);
        showToast('Timer diatur ' + minutes + ' menit');
    }
    closePlayerMenuModal();
}

function toggleFavoritLagu() {
    if(!currentTrack) return;
    var tx = db.transaction('favorite_songs', 'readwrite');
    var store = tx.objectStore('favorite_songs');
    var getReq = store.get(currentTrack.videoId);
    getReq.onsuccess = function() {
        if(getReq.result) { store.delete(currentTrack.videoId); showToast('Dihapus dari Favorit'); } 
        else { store.put(currentTrack); showToast('Ditambahkan ke Favorit'); }
        renderLibraryUI();
        closePlayerMenuModal();
    };
}

function shareLagu() {
    if(navigator.share && currentTrack) {
        navigator.share({
            title: currentTrack.title,
            text: 'Dengarkan ' + currentTrack.title + ' oleh ' + currentTrack.artist + ' di Soundify!',
            url: window.location.href
        }).catch(function(err) { console.log('Share gagal', err); });
    } else {
        showToast('Fitur bagi tidak didukung di browser ini');
    }
    closePlayerMenuModal();
}

// --- LIKE SYSTEM ---
function checkIfLiked(videoId) {
    if(!db) return;
    var tx = db.transaction('liked_songs', 'readonly');
    var request = tx.objectStore('liked_songs').get(videoId);
    request.onsuccess = function() {
        var btnSvg = document.getElementById('btnLikeSong');
        if(btnSvg) {
            if(request.result) {
                btnSvg.style.fill = '#1db954';
                btnSvg.style.stroke = '#1db954';
            } else {
                btnSvg.style.fill = 'transparent';
                btnSvg.style.stroke = 'white';
            }
        }
    };
}

function toggleLike() {
    if(!currentTrack) return;
    var tx = db.transaction('liked_songs', 'readwrite');
    var store = tx.objectStore('liked_songs');
    var getReq = store.get(currentTrack.videoId);

    getReq.onsuccess = function() {
        var btnSvg = document.getElementById('btnLikeSong');
        if(getReq.result) {
            store.delete(currentTrack.videoId);
            if(btnSvg) {
                btnSvg.style.fill = 'transparent';
                btnSvg.style.stroke = 'white';
            }
            showToast('Dihapus dari Suka');
        } else {
            store.put(currentTrack);
            if(btnSvg) {
                btnSvg.style.fill = '#1db954';
                btnSvg.style.stroke = '#1db954';
            }
            showToast('Ditambahkan ke Suka');
        }
        renderLibraryUI();
    };
}

// --- UTILS & TOAST ---
var toastTimeout;
function showToast(message) {
    var toast = document.getElementById('customToast');
    if (!toast) return;
    toast.innerText = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function() { toast.classList.remove('show'); }, 3000);
}

function updateMediaSession() {
    updateMediaSessionNow();
}

// Switch View
function switchView(viewName, pushState) {
    if(pushState === undefined) pushState = true;
    document.querySelectorAll('.view-section').forEach(function(el) { el.classList.remove('active'); });
    var target = document.getElementById('view-' + viewName);
    if (target) target.classList.add('active');
    
    var navItems = document.querySelectorAll('.bottom-nav .nav-item');
    navItems.forEach(function(nav) { nav.classList.remove('active'); });
    if(viewName === 'home') { if(navItems[0]) navItems[0].classList.add('active'); }
    else if (viewName === 'search') { if(navItems[1]) navItems[1].classList.add('active'); }
    else if (viewName === 'library') { if(navItems[2]) navItems[2].classList.add('active'); renderLibraryUI(); }
    else if (viewName === 'developer') { if(navItems[3]) navItems[3].classList.add('active'); }
    
    window.scrollTo(0,0);

    if (pushState) {
        history.pushState({ view: viewName }, '', '#' + viewName);
    }
}

var dotsSvg = '<svg class="dots-icon" viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>';

function getHighResImage(url) {
    if (!url) return 'https://placehold.co/140x140/282828/FFFFFF?text=Music';
    if (url.match(/=w\d+-h\d+/)) return url.replace(/=w\d+-h\d+[^&]*/g, '=w512-h512-l90-rj');
    return url;
}

function createListHTML(track, context) {
    if(context === undefined) context = null;
    var img = track.thumbnail ? track.thumbnail : (track.img ? track.img : 'https://placehold.co/48x48/282828/FFFFFF?text=Music');
    img = getHighResImage(img); 
    var artist = track.artist ? track.artist : 'Unknown';
    var trackData = encodeURIComponent(JSON.stringify({videoId: track.videoId, title: track.title, artist: artist, img: img})).replace(/'/g, '%27');
    var ctxString = context ? encodeURIComponent(JSON.stringify(context)).replace(/'/g, '%27') : 'null';
    
    return `
        <div class="v-item" id="item-${track.videoId}">
            <input type="checkbox" class="v-checkbox" onchange="handleCheckDelete('${track.videoId}', this.checked)">
            <img src="${img}" class="v-img" onclick="playMusic('${track.videoId}', '${trackData}', ${ctxString !== 'null' ? 'JSON.parse(decodeURIComponent(\'' + ctxString + '\'))' : 'null'})" onerror="this.src='https://placehold.co/48x48/282828/FFFFFF?text=Music'">
            <div class="v-info" onclick="playMusic('${track.videoId}', '${trackData}', ${ctxString !== 'null' ? 'JSON.parse(decodeURIComponent(\'' + ctxString + '\'))' : 'null'})">
                <div class="v-title">${track.title}</div>
                <div class="v-sub">${artist}</div>
            </div>
            <div class="dots-container" onclick="playMusic('${track.videoId}', '${trackData}', ${ctxString !== 'null' ? 'JSON.parse(decodeURIComponent(\'' + ctxString + '\'))' : 'null'}); setTimeout(openPlayerMenuModal, 500)">
                ${dotsSvg}
            </div>
        </div>
    `;
}

function createCardHTML(track, isArtist) {
    if(isArtist === undefined) isArtist = false;
    var img = track.thumbnail ? track.thumbnail : (track.img ? track.img : 'https://placehold.co/140x140/282828/FFFFFF?text=Music');
    img = getHighResImage(img); 
    var artist = track.artist ? track.artist : 'Unknown';
    var trackData = encodeURIComponent(JSON.stringify({videoId: track.videoId, title: track.title, artist: artist, img: img})).replace(/'/g, '%27');
    var clickAction = isArtist ? 'openArtistView(\'' + track.title.replace(/'/g, '\\\'') + '\')' : 'playMusic(\'' + track.videoId + '\', \'' + trackData + '\', null)';
    var imgClass = isArtist ? 'h-img artist-img' : 'h-img';

    return `
        <div class="h-card" onclick="${clickAction}">
            <img src="${img}" class="${imgClass}" onerror="this.src='https://placehold.co/140x140/282828/FFFFFF?text=Music'">
            <div class="h-title">${track.title}</div>
            <div class="h-sub">${isArtist ? 'Artis' : artist}</div>
        </div>
    `;
}

// --- DATA FETCHING ---
var homeDisplayedVideoIds = new Set();
async function fetchAndRender(query, containerId, formatType, isArtist, isHome) {
    if(isArtist === undefined) isArtist = false;
    if(isHome === undefined) isHome = false;
    try {
        var response = await fetch('/api/search?query=' + encodeURIComponent(query));
        var result = await response.json();
        if (result.status === 'success') {
            var limit = containerId === 'recentList' ? 4 : (formatType === 'list' ? 4 : 8);
            var tracks = [];
            for (var i = 0; i < result.data.length; i++) {
                var t = result.data[i];
                if (isHome) {
                    if (!homeDisplayedVideoIds.has(t.videoId)) { tracks.push(t); homeDisplayedVideoIds.add(t.videoId); }
                } else { tracks.push(t); }
                if (tracks.length >= limit) break;
            }
            var html = '';
            tracks.forEach(function(t) { html += formatType === 'list' ? createListHTML(t) : createCardHTML(t, isArtist); });
            document.getElementById(containerId).innerHTML = html;
        }
    } catch (error) {
        document.getElementById(containerId).innerHTML = '<div style="color:var(--text-sub); font-size: 13px;">Sedang Offline (Koneksi Terputus)</div>';
    }
}

function loadHomeData() {
    homeDisplayedVideoIds.clear();
    fetchAndRender('lagu indonesia hits terbaru', 'recentList', 'list', false, true);
    fetchAndRender('lagu pop indonesia rilis terbaru anyar', 'rowAnyar', 'card', false, true);
    fetchAndRender('lagu ceria gembira semangat', 'rowGembira', 'card', false, true);
    fetchAndRender('top 50 indonesia playlist update', 'rowCharts', 'card', false, true);
    fetchAndRender('lagu galau sedih indonesia terpopuler', 'rowGalau', 'card', false, true);
    fetchAndRender('lagu viral terbaru 2026', 'rowBaru', 'card', false, true);
    fetchAndRender('lagu fyp tiktok viral jedag jedug', 'rowTiktok', 'card', false, true);
    fetchAndRender('penyanyi pop indonesia paling hits', 'rowArtists', 'card', true, true);
}

function renderSearchCategories() {
    var categories = [
        { title: 'Dibuat Untuk Kamu', color: '#8d67ab', img: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=100&q=80' },
        { title: 'Rilis Mendatang', color: '#188653', img: 'https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=100&q=80' },
        { title: 'Pop', color: '#477d95', img: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=100&q=80' },
        { title: 'Musik Indonesia', color: '#e8115b', img: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=100&q=80' }
    ];
    var html = '';
    categories.forEach(function(cat) { html += '<div class="category-card" style="background-color: ' + cat.color + ';"><div class="category-title">' + cat.title + '</div><img src="' + cat.img + '" class="category-img"></div>'; });
    document.getElementById('categoryGrid').innerHTML = html;
}

var searchTimeout;
document.getElementById('searchInput').addEventListener('input', function(e) {
    clearTimeout(searchTimeout);
    var query = e.target.value.trim();
    if (query.length === 0) {
        document.getElementById('searchCategoriesUI').style.display = 'block';
        document.getElementById('searchResultsUI').style.display = 'none';
        return;
    }
    document.getElementById('searchCategoriesUI').style.display = 'none';
    document.getElementById('searchResultsUI').style.display = 'block';

    searchTimeout = setTimeout(async function() {
        document.getElementById('searchResults').innerHTML = '<div style="color:var(--text-sub); text-align:center;">Mencari musik...</div>';
        try {
            var response = await fetch('/api/search?query=' + encodeURIComponent(query));
            var result = await response.json();
            if (result.status === 'success') {
                var html = '';
                result.data.forEach(function(t) { html += createListHTML(t); });
                document.getElementById('searchResults').innerHTML = html;
            }
        } catch (error) {
            document.getElementById('searchResults').innerHTML = '<div style="color:var(--text-sub); text-align:center;">Anda Sedang Offline</div>';
        }
    }, 800);
});

async function openArtistView(artistName) {
    document.getElementById('artistNameDisplay').innerText = artistName;
    document.getElementById('artistTracksContainer').innerHTML = '<div style="color:var(--text-sub); text-align:center;">Memuat lagu artis...</div>';
    switchView('artist');
    try {
        var response = await fetch('/api/search?query=' + encodeURIComponent(artistName + ' official audio'));
        var result = await response.json();
        if (result.status === 'success') {
            var html = '';
            var ctx = { type: 'artist', data: result.data };
            result.data.forEach(function(track) { html += createListHTML(track, ctx); });
            document.getElementById('artistTracksContainer').innerHTML = html;
            
            if(result.data.length > 0) {
                var firstTrack = result.data[0];
                var img = firstTrack.thumbnail ? firstTrack.thumbnail : (firstTrack.img ? firstTrack.img : 'https://placehold.co/48x48/282828/FFFFFF?text=Music');
                img = getHighResImage(img);
                var trackData = encodeURIComponent(JSON.stringify({videoId: firstTrack.videoId, title: firstTrack.title, artist: firstTrack.artist || 'Unknown', img: img})).replace(/'/g, '%27');
                var ctxString = encodeURIComponent(JSON.stringify(ctx)).replace(/'/g, '%27');
                document.querySelector('.artist-play-btn').setAttribute('onclick', 'playMusic(\'' + firstTrack.videoId + '\', \'' + trackData + '\', JSON.parse(decodeURIComponent(\'' + ctxString + '\')))');
            }
        }
    } catch(e) {}
}

function renderLibraryUI() {
    if(!db) return;
    var container = document.getElementById('libraryContainer');
    if(!container) return;
    var html = '';

    var txL = db.transaction('liked_songs', 'readonly');
    var reqL = txL.objectStore('liked_songs').getAll();
    reqL.onsuccess = function() {
        var likedCount = reqL.result.length;
        html += `
            <div class="lib-item" onclick="openPlaylistView('liked')">
                <div class="lib-item-img liked">
                    <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg>
                </div>
                <div class="lib-item-info">
                    <div class="lib-item-title">Suka</div>
                    <div class="lib-item-sub">Koleksi \u2022 ${likedCount} lagu</div>
                </div>
            </div>
        `;
        
        var txF = db.transaction('favorite_songs', 'readonly');
        var reqF = txF.objectStore('favorite_songs').getAll();
        reqF.onsuccess = function() {
            var favCount = reqF.result.length;
            html += `
                <div class="lib-item" onclick="openPlaylistView('favorite')">
                    <div class="lib-item-img fav">
                        <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path></svg>
                    </div>
                    <div class="lib-item-info">
                        <div class="lib-item-title">Favorit</div>
                        <div class="lib-item-sub">Koleksi \u2022 ${favCount} lagu</div>
                    </div>
                </div>
            `;

            var txH = db.transaction('history_songs', 'readonly');
            var reqH = txH.objectStore('history_songs').getAll();
            reqH.onsuccess = function() {
                var historyData = reqH.result.sort(function(a,b) { return b.timestamp - a.timestamp; });
                var histCount = historyData.length;
                html += `
                    <div class="lib-item" onclick="openPlaylistView('history')">
                        <div class="lib-item-img hist">
                            <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"></path></svg>
                        </div>
                        <div class="lib-item-info">
                            <div class="lib-item-title">Histori Putar</div>
                            <div class="lib-item-sub">Otomatis \u2022 ${histCount} lagu</div>
                        </div>
                    </div>
                `;

                var txO = db.transaction('offline_songs', 'readonly');
                var reqO = txO.objectStore('offline_songs').getAll();
                reqO.onsuccess = function() {
                    var offCount = reqO.result.length;
                    html += `
                        <div class="lib-item" onclick="openPlaylistView('offline')">
                            <div class="lib-item-img off">
                                <svg viewBox="0 0 24 24" style="fill:white; width:28px; height:28px;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>
                            </div>
                            <div class="lib-item-info">
                                <div class="lib-item-title">Unduhan (Offline)</div>
                                <div class="lib-item-sub">Memori Perangkat \u2022 ${offCount} lagu</div>
                            </div>
                        </div>
                    `;

                    var txP = db.transaction('playlists', 'readonly');
                    var reqP = txP.objectStore('playlists').getAll();
                    reqP.onsuccess = function() {
                        var playlists = reqP.result;
                        playlists.forEach(function(p) {
                            html += `
                                <div class="lib-item" onclick="openPlaylistView('${p.id}')">
                                    <img src="${p.img || 'https://via.placeholder.com/120?text=+'}" class="lib-item-img" onerror="this.src='https://via.placeholder.com/120?text=+'">
                                    <div class="lib-item-info">
                                        <div class="lib-item-title">${p.name}</div>
                                        <div class="lib-item-sub">Playlist \u2022 Kamu</div>
                                    </div>
                                </div>
                            `;
                        });
                        container.innerHTML = html;
                    };
                };
            };
        };
    };
}

var currentPlaylistTracks = [];
var activePlaylistId = null;

var pathHeart = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
var pathStar = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
var pathClock = 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z';
var pathDownload = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';

function setPlaylistCover(gradient, svgPath) {
    var box = document.getElementById('playlistImageContainer');
    var img = document.getElementById('playlistImageDisplay');
    var svg = document.getElementById('playlistSvgDisplay');
    if (!box || !img || !svg) return;
    
    box.style.background = gradient;
    img.style.display = 'none';
    svg.style.display = 'block';
    svg.innerHTML = '<path d="' + svgPath + '"></path>';
}

function openPlaylistView(id) {
    activePlaylistId = id;
    isEditMode = false;
    document.getElementById('bulkActionBar').style.display = 'none';
    switchView('playlist');
    var container = document.getElementById('playlistTracksContainer');
    if (container) container.innerHTML = '<div style="color:var(--text-sub); text-align:center;">Memuat daftar lagu...</div>';

    if (id === 'liked') {
        document.getElementById('playlistNameDisplay').innerText = 'Suka';
        setPlaylistCover('linear-gradient(135deg, #450af5, #c4efd9)', pathHeart);
        var tx = db.transaction('liked_songs', 'readonly');
        var req = tx.objectStore('liked_songs').getAll();
        req.onsuccess = function() { processPlaylistData(req.result, 'liked'); };
    } 
    else if (id === 'favorite') {
        document.getElementById('playlistNameDisplay').innerText = 'Favorit';
        setPlaylistCover('linear-gradient(135deg, #e1118c, #f5a623)', pathStar);
        var tx = db.transaction('favorite_songs', 'readonly');
        var req = tx.objectStore('favorite_songs').getAll();
        req.onsuccess = function() { processPlaylistData(req.result, 'favorite'); };
    }
    else if (id === 'history') {
        document.getElementById('playlistNameDisplay').innerText = 'Histori Putar';
        setPlaylistCover('linear-gradient(135deg, #1e3264, #477d95)', pathClock);
        var tx = db.transaction('history_songs', 'readonly');
        var req = tx.objectStore('history_songs').getAll();
        req.onsuccess = function() { 
            var histData = req.result.sort(function(a,b) { return b.timestamp - a.timestamp; });
            processPlaylistData(histData, 'history'); 
        };
    }
    else if (id === 'offline') {
        document.getElementById('playlistNameDisplay').innerText = 'Lagu Unduhan (Offline)';
        setPlaylistCover('linear-gradient(135deg, #2a2a2a, #535353)', pathDownload);
        var tx = db.transaction('offline_songs', 'readonly');
        var req = tx.objectStore('offline_songs').getAll();
        req.onsuccess = function() { processPlaylistData(req.result, 'offline'); };
    }
    else {
        var tx = db.transaction('playlists', 'readonly');
        var req = tx.objectStore('playlists').get(id);
        req.onsuccess = function() {
            var p = req.result;
            document.getElementById('playlistNameDisplay').innerText = p.name;
            var box = document.getElementById('playlistImageContainer');
            if (box) box.style.background = 'transparent';
            document.getElementById('playlistSvgDisplay').style.display = 'none';
            document.getElementById('playlistImageDisplay').style.display = 'block';
            document.getElementById('playlistImageDisplay').src = p.img || 'https://via.placeholder.com/240/282828/ffffff?text=+';
            processPlaylistData(p.tracks || [], 'playlist');
        };
    }
}

function processPlaylistData(dataArr, typeId) {
    currentPlaylistTracks = dataArr || [];
    document.getElementById('playlistStatsDisplay').innerText = currentPlaylistTracks.length + ' lagu disimpan';
    var container = document.getElementById('playlistTracksContainer');
    if (!container) return;
    if (currentPlaylistTracks.length === 0) {
        container.innerHTML = '<div style="color:var(--text-sub); text-align:center;">Daftar ini masih kosong.</div>';
        return;
    }
    var html = '';
    var ctx = { type: typeId, data: currentPlaylistTracks };
    currentPlaylistTracks.forEach(function(t) { html += createListHTML(t, ctx); });
    container.innerHTML = html;
}

function playFirstPlaylistTrack() {
    if(currentPlaylistTracks && currentPlaylistTracks.length > 0) {
        var firstTrack = currentPlaylistTracks[0];
        var trackData = encodeURIComponent(JSON.stringify(firstTrack)).replace(/'/g, '%27');
        var ctxString = encodeURIComponent(JSON.stringify({ type: 'auto', data: currentPlaylistTracks })).replace(/'/g, '%27');
        playMusic(firstTrack.videoId, trackData, JSON.parse(decodeURIComponent(ctxString)));
    }
}

// --- LOGIC HAPUS BANYAK ---
function toggleEditMode() {
    isEditMode = !isEditMode;
    selectedTracksForDelete.clear();
    
    var items = document.querySelectorAll('#playlistTracksContainer .v-item');
    items.forEach(function(item) {
        if(isEditMode) {
            item.classList.add('editing');
        } else {
            item.classList.remove('editing');
            var cb = item.querySelector('.v-checkbox');
            if (cb) cb.checked = false;
        }
    });

    var bar = document.getElementById('bulkActionBar');
    if(isEditMode) {
        if (bar) bar.style.display = 'flex';
        updateDeleteCount();
    } else {
        if (bar) bar.style.display = 'none';
    }
}

function handleCheckDelete(videoId, isChecked) {
    if(isChecked) selectedTracksForDelete.add(videoId);
    else selectedTracksForDelete.delete(videoId);
    updateDeleteCount();
}

function updateDeleteCount() {
    document.getElementById('selCountText').innerText = selectedTracksForDelete.size + ' lagu dipilih';
}

function deleteSelectedTracks() {
    if(selectedTracksForDelete.size === 0) {
        showToast('Pilih minimal satu lagu untuk dihapus');
        return;
    }
    
    var storeName = '';
    if(activePlaylistId === 'liked') storeName = 'liked_songs';
    else if(activePlaylistId === 'favorite') storeName = 'favorite_songs';
    else if(activePlaylistId === 'history') storeName = 'history_songs';
    else if(activePlaylistId === 'offline') storeName = 'offline_songs';

    if(storeName) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        selectedTracksForDelete.forEach(function(id) {
            if(activePlaylistId === 'history') {
                var req = store.openCursor();
                req.onsuccess = function(e) {
                    var cursor = e.target.result;
                    if(cursor) {
                        if(cursor.value.videoId === id) cursor.delete();
                        cursor.continue();
                    }
                };
            } else {
                store.delete(id);
            }
        });
        tx.oncomplete = function() {
            showToast(selectedTracksForDelete.size + ' lagu dihapus');
            openPlaylistView(activePlaylistId); 
        };
    } else {
        var tx = db.transaction('playlists', 'readwrite');
        var store = tx.objectStore('playlists');
        var req = store.get(activePlaylistId);
        req.onsuccess = function() {
            var p = req.result;
            p.tracks = p.tracks.filter(function(t) { return !selectedTracksForDelete.has(t.videoId); });
            store.put(p);
            showToast(selectedTracksForDelete.size + ' lagu dihapus dari Playlist');
            openPlaylistView(activePlaylistId);
        };
    }
}

var base64PlaylistImage = '';
function openCreatePlaylist() { document.getElementById('createPlaylistModal').style.display = 'block'; }
function closeCreatePlaylist() {
    document.getElementById('createPlaylistModal').style.display = 'none';
    document.getElementById('cpName').value = '';
    document.getElementById('cpPreview').src = 'https://via.placeholder.com/120x120?text=+';
    base64PlaylistImage = '';
}
function previewImage(event) {
    var file = event.target.files[0];
    var reader = new FileReader();
    reader.onloadend = function() {
        document.getElementById('cpPreview').src = reader.result;
        base64PlaylistImage = reader.result;
    };
    if(file) reader.readAsDataURL(file);
}
function saveNewPlaylist() {
    var name = document.getElementById('cpName').value || 'Playlist baruku';
    var newPlaylist = { id: Date.now().toString(), name: name, img: base64PlaylistImage, tracks: [] };
    var tx = db.transaction('playlists', 'readwrite');
    tx.objectStore('playlists').put(newPlaylist);
    tx.oncomplete = function() { closeCreatePlaylist(); renderLibraryUI(); };
}

function openAddToPlaylistModal() {
    if(!currentTrack) return;
    var tx = db.transaction('playlists', 'readonly');
    var req = tx.objectStore('playlists').getAll();
    req.onsuccess = function() {
        var html = '';
        req.result.forEach(function(p) {
            html += `
                <div class="lib-item" onclick="addTrackToPlaylist('${p.id}')" style="margin-bottom: 12px; cursor: pointer;">
                    <img src="${p.img || 'https://via.placeholder.com/50'}" style="width:50px; height:50px; object-fit:cover; border-radius:4px;" onerror="this.src='https://via.placeholder.com/50'">
                    <div style="color:white; font-size:16px;">${p.name}</div>
                </div>`;
        });
        if(req.result.length === 0) html = '<div style="color:#a7a7a7; text-align:center;">Belum ada playlist. Buat dulu di Koleksi Kamu.</div>';
        document.getElementById('addToPlaylistList').innerHTML = html;
        document.getElementById('addToPlaylistModal').style.display = 'flex';
    };
}
function closeAddToPlaylistModal() { document.getElementById('addToPlaylistModal').style.display = 'none'; }
function addTrackToPlaylist(playlistId) {
    var tx = db.transaction('playlists', 'readwrite');
    var store = tx.objectStore('playlists');
    var req = store.get(playlistId);
    req.onsuccess = function() {
        var p = req.result;
        if(!p.tracks) p.tracks = [];
        if(!p.tracks.find(function(t) { return t.videoId === currentTrack.videoId; })) {
            p.tracks.push(currentTrack);
            store.put(p);
            showToast('Ditambahkan ke ' + p.name); 
        } else {
            showToast('Sudah ada di ' + p.name); 
        }
        closeAddToPlaylistModal();
    };
}

// --- BIAR LAGU TETAP JALAN SAAT KELUAR APP ---
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        console.log('App di background, musik tetap jalan');
    } else {
        if (isPlaying) {
            var mini = document.getElementById('persistentMiniPlayer');
            if (mini && currentTrack) {
                mini.style.display = 'flex';
            }
        }
        updatePersistentProgress();
    }
});

console.log('Soundify Music Player Loaded');
