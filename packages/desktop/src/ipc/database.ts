import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import type { Track, Album } from '../types'

let db: Database.Database | null = null

function getDbPath(): string {
  const userData = app.getPath('userData')
  const dir = path.join(userData, 'aurora-music')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, 'library.db')
}

export function initDatabase(): Database.Database {
  const dbPath = getDbPath()
  try {
    db = new Database(dbPath)
    // 完整性检查：数据库损坏时备份并重建，避免应用无法启动
    const check = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (check[0]?.integrity_check !== 'ok') {
      throw new Error(`数据库完整性检查失败: ${check[0]?.integrity_check}`)
    }
  } catch (err) {
    console.error('数据库打开失败，备份损坏文件并重建:', err)
    try { db?.close() } catch {}
    db = null
    // 将损坏的库文件（含 WAL/SHM）改名备份，便于用户找回数据
    const backupPath = `${dbPath}.corrupt-${Date.now()}`
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix
      if (fs.existsSync(f)) {
        try { fs.renameSync(f, backupPath + suffix) } catch {}
      }
    }
    db = new Database(dbPath)
  }
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      year INTEGER,
      genre TEXT,
      duration REAL,
      track_number INTEGER,
      cover_path TEXT,
      file_size INTEGER,
      added_at INTEGER,
      last_played_at INTEGER,
      play_count INTEGER DEFAULT 0,
      liked INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      artist TEXT,
      cover_path TEXT,
      year INTEGER
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT,
      track_id TEXT,
      position INTEGER,
      PRIMARY KEY (playlist_id, track_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album, artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_liked ON tracks(liked);
    CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played_at);
  `)

  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

/** 批量事务插入（扫描提速：N 条记录只开一个事务） */
export function insertTracks(tracks: Track[]): void {
  if (tracks.length === 0) return
  const d = getDb()
  const stmt = d.prepare(`
    INSERT INTO tracks (id, path, title, artist, album, year, genre, duration, track_number, cover_path, file_size, added_at, last_played_at, play_count, liked)
    VALUES (@id, @path, @title, @artist, @album, @year, @genre, @duration, @trackNumber, @coverPath, @fileSize, @addedAt, @lastPlayedAt, @playCount, @liked)
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      year = excluded.year,
      genre = excluded.genre,
      duration = excluded.duration,
      track_number = excluded.track_number,
      cover_path = excluded.cover_path,
      file_size = excluded.file_size
  `)
  const runAll = d.transaction((items: Track[]) => {
    for (const track of items) {
      stmt.run({
        id: track.id,
        path: track.path,
        title: track.title,
        artist: track.artist || null,
        album: track.album || null,
        year: track.year || null,
        genre: track.genre || null,
        duration: track.duration,
        trackNumber: track.trackNumber || null,
        coverPath: track.coverPath || null,
        fileSize: track.fileSize || null,
        addedAt: track.addedAt,
        lastPlayedAt: track.lastPlayedAt || null,
        playCount: track.playCount,
        liked: track.liked ? 1 : 0,
      })
    }
  })
  runAll(tracks)
}

export function getAllTracks(): Track[] {
  const d = getDb()
  return d.prepare('SELECT * FROM tracks ORDER BY artist, album, track_number, title').all().map(rowToTrack)
}

export function getTrackById(id: string): Track | null {
  const d = getDb()
  const row = d.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as any
  return row ? rowToTrack(row) : null
}

/** 批量按路径查询（扫描时用一次 SQL 预取，替代逐文件查询） */
export function getTracksByPaths(paths: string[]): Map<string, Track> {
  const d = getDb()
  const result = new Map<string, Track>()
  if (paths.length === 0) return result
  const stmt = d.prepare('SELECT * FROM tracks WHERE path = ?')
  for (const p of paths) {
    const row = stmt.get(p)
    if (row) result.set(p, rowToTrack(row))
  }
  return result
}

export function searchTracks(query: string): Track[] {
  const d = getDb()
  const q = `%${query}%`
  return d.prepare(`
    SELECT * FROM tracks WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY title
  `).all(q, q, q).map(rowToTrack)
}

// 允许更新的字段白名单（camelCase → 列名），防止任意字段注入
const UPDATABLE_COLUMNS: Record<string, string> = {
  title: 'title',
  artist: 'artist',
  album: 'album',
  year: 'year',
  genre: 'genre',
  duration: 'duration',
  trackNumber: 'track_number',
  coverPath: 'cover_path',
  fileSize: 'file_size',
  addedAt: 'added_at',
  lastPlayedAt: 'last_played_at',
  playCount: 'play_count',
  liked: 'liked',
}

export function updateTrack(id: string, updates: Partial<Track>): void {
  const d = getDb()
  const fields: string[] = []
  const params: Record<string, unknown> = { id }
  for (const [key, value] of Object.entries(updates)) {
    const col = UPDATABLE_COLUMNS[key]
    if (!col) continue
    fields.push(`${col} = @${key}`)
    // liked 存为 0/1；其余 undefined 统一转 null，避免 better-sqlite3 绑定 undefined 抛错
    params[key] = key === 'liked' ? (value ? 1 : 0) : value ?? null
  }
  if (fields.length === 0) return
  const stmt = d.prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = @id`)
  stmt.run(params)
}

export function deleteTrack(id: string): void {
  const d = getDb()
  // 删除曲目前先取出封面路径，同步清理磁盘上的封面缓存文件
  const row = d.prepare('SELECT cover_path FROM tracks WHERE id = ?').get(id) as { cover_path?: string } | undefined
  d.prepare('DELETE FROM tracks WHERE id = ?').run(id)
  removeCoverFile(row?.cover_path)
}

function removeCoverFile(coverPath?: string | null): void {
  if (!coverPath) return
  // 只清理本应用封面缓存目录内的文件，避免误删用户文件
  try {
    const coverDir = path.join(app.getPath('userData'), 'aurora-music', 'covers')
    if (path.dirname(coverPath) === coverDir && fs.existsSync(coverPath)) {
      fs.unlinkSync(coverPath)
    }
  } catch (err) {
    console.warn('清理封面文件失败:', coverPath, err)
  }
}

/**
 * 清理扫描目录下已不存在的文件的曲目记录（歌曲被删除/移动后同步移除）。
 * 仅处理 rootPath 前缀范围内的记录，避免误删其他扫描目录的曲目。
 * 返回删除的曲目数量。
 */
export function deleteTracksWithMissingFiles(rootPath: string, existingPaths: ReadonlySet<string>): number {
  const d = getDb()
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep
  // 只取前缀范围内的记录，避免全表加载到 JS 层
  const rows = d.prepare('SELECT id, path, cover_path FROM tracks WHERE path LIKE ?').all(prefix + '%') as Array<{ id: string; path: string; cover_path?: string }>
  // LIKE 的通配符可能匹配到额外字符，用 startsWith 精确校验前缀
  const stale = rows.filter((r) => r.path.startsWith(prefix) && !existingPaths.has(r.path))
  if (stale.length === 0) return 0
  const stmt = d.prepare('DELETE FROM tracks WHERE id = ?')
  const delMany = d.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id)
  })
  delMany(stale.map((t) => t.id))
  // 同步清理被删曲目的封面缓存文件，避免磁盘泄漏
  for (const t of stale) removeCoverFile(t.cover_path)
  return stale.length
}

export function insertAlbum(album: Album): void {
  const d = getDb()
  d.prepare(`
    INSERT OR REPLACE INTO albums (id, name, artist, cover_path, year)
    VALUES (@id, @name, @artist, @coverPath, @year)
  `).run({
    id: album.id,
    name: album.name,
    artist: album.artist || null,
    coverPath: album.coverPath || null,
    year: album.year || null,
  })
}

export function getAllAlbums(): Album[] {
  const d = getDb()
  return d.prepare('SELECT * FROM albums ORDER BY name').all().map(rowToAlbum)
}

export function getLikedTracks(): Track[] {
  const d = getDb()
  return d.prepare('SELECT * FROM tracks WHERE liked = 1 ORDER BY title').all().map(rowToTrack)
}

export function getRecentlyPlayed(limit = 50): Track[] {
  const d = getDb()
  return d.prepare('SELECT * FROM tracks WHERE last_played_at IS NOT NULL ORDER BY last_played_at DESC LIMIT ?').all(limit).map(rowToTrack)
}

export function getMostPlayed(limit = 50): Track[] {
  const d = getDb()
  return d.prepare('SELECT * FROM tracks WHERE play_count > 0 ORDER BY play_count DESC LIMIT ?').all(limit).map(rowToTrack)
}

function rowToTrack(row: any): Track {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    artist: row.artist || '未知艺术家',
    album: row.album || '未知专辑',
    year: row.year || undefined,
    genre: row.genre || undefined,
    duration: row.duration || 0,
    trackNumber: row.track_number || undefined,
    coverPath: row.cover_path || undefined,
    fileSize: row.file_size || undefined,
    addedAt: row.added_at,
    lastPlayedAt: row.last_played_at || undefined,
    playCount: row.play_count || 0,
    liked: !!row.liked,
  }
}

function rowToAlbum(row: any): Album {
  return {
    id: row.id,
    name: row.name,
    artist: row.artist || '未知艺术家',
    coverPath: row.cover_path || undefined,
    year: row.year || undefined,
    trackCount: 0,
  }
}

/** 应用退出时关闭数据库，确保 WAL 数据落盘 */
export function closeDatabase(): void {
  if (db) {
    try { db.close() } catch {}
    db = null
  }
}
