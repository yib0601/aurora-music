import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'
import type { DatabaseAdapter, Track, Album, Playlist } from '@/types'

const DB_NAME = 'aurora-music-library'
const DB_VERSION = 1

// sqlite: SQLiteConnection 单例（管理多连接）
// dbConn: SQLiteDBConnection 实例（具体数据库句柄）
let sqlite: SQLiteConnection | null = null
let dbConn: SQLiteDBConnection | null = null
let initialized = false
// in-flight Promise 缓存：移动端 App 启动时 platform.getAllTracks() 和
// platform.scanFolder() 会在同一个 useEffect 中并发触发，二者都会调用
// ensureDbInited() → db.init()。即使外部 ensureDbInited 用 Promise 缓存，
// 仍可能在 microtask 边界处产生二次进入。把 Promise 缓存下沉到 init 内部，
// 保证 createConnection 只被调用一次，彻底避免 "Connection already exists"。
let initInFlight: Promise<void> | null = null

// 移动端曲目行结构（与桌面端 database.ts 一致）
interface TrackRow {
  id: string
  path: string
  title: string
  artist: string | null
  album: string | null
  year: number | null
  genre: string | null
  duration: number | null
  track_number: number | null
  cover_path: string | null
  file_size: number | null
  added_at: number
  last_played_at: number | null
  play_count: number
  liked: number
}

interface AlbumRow {
  id: string
  name: string
  artist: string | null
  cover_path: string | null
  year: number | null
}

function rowToTrack(row: TrackRow): Track {
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

function rowToAlbum(row: AlbumRow): Album {
  return {
    id: row.id,
    name: row.name,
    artist: row.artist || '未知艺术家',
    coverPath: row.cover_path || undefined,
    year: row.year || undefined,
    trackCount: 0,
  }
}

export class MobileDatabase implements DatabaseAdapter {
  async init(): Promise<void> {
    if (initialized) return
    // 并发去重：多个 caller 并发调 init() 时，第一个 caller 走真正的初始化流程，
    // 其余 caller 直接 await 同一个 in-flight Promise。失败时清空缓存允许重试。
    if (initInFlight) {
      try {
        await initInFlight
      } catch (e) {
        // 重试由 caller 自行处理（initInFlight 已被 catch 块清空）
      }
      return
    }
    initInFlight = (async () => {
      try {
        // initWebStore 仅 web 平台实现；Android/iOS 原生未实现会抛 "not implemented"，
        // 因此必须用平台判断而不是 truthy 检查（Capacitor Proxy 会让未实现方法为 truthy）
        if (Capacitor.getPlatform() === 'web') {
          await CapacitorSQLite.initWebStore()
        }
        sqlite = new SQLiteConnection(CapacitorSQLite)
        // createConnection 返回 SQLiteDBConnection 句柄，后续所有操作均通过该句柄
        dbConn = await sqlite.createConnection(
          DB_NAME,
          false, // encrypted
          'no-encryption',
          DB_VERSION,
          false, // readonly
        )
        await dbConn.open()
        // 建表脚本（与桌面端 packages/desktop/src/ipc/database.ts 完全一致，便于数据迁移）
        await dbConn.execute(`
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
        // WASM 模式下没有 foreign_keys pragma 支持；原生 Android 默认开启
        try {
          await dbConn.execute('PRAGMA foreign_keys = ON;')
        } catch {
          // 部分平台/版本不支持 PRAGMA，忽略
        }
        console.log('[MobileDB] 数据库已初始化')
        initialized = true
      } catch (err) {
        console.error('[MobileDB] 初始化失败:', err)
        // 失败时清空 in-flight 缓存，允许后续重试
        initInFlight = null
        throw err
      }
    })()
    try {
      await initInFlight
    } catch (e) {
      // initInFlight 已在内部 catch 清空，这里直接抛出
      throw e
    }
  }

  private async query<T>(statement: string, values: any[] = []): Promise<T[]> {
    if (!dbConn) throw new Error('数据库未初始化')
    const res = await dbConn.query(statement, values)
    return (res.values || []) as T[]
  }

  private async run(statement: string, values: any[] = []): Promise<number> {
    if (!dbConn) throw new Error('数据库未初始化')
    const res = await dbConn.run(statement, values, true)
    return res.changes?.changes ?? 0
  }

  async insertTrack(track: Track): Promise<void> {
    // 与桌面端一致：path 冲突时按已有记录更新元数据，保留原 id 与用户数据（播放统计/收藏/入库时间）
    const statement = `
      INSERT INTO tracks (id, path, title, artist, album, year, genre, duration, track_number, cover_path, file_size, added_at, last_played_at, play_count, liked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    `
    await this.run(statement, [
      track.id,
      track.path,
      track.title,
      track.artist || null,
      track.album || null,
      track.year || null,
      track.genre || null,
      track.duration,
      track.trackNumber || null,
      track.coverPath || null,
      track.fileSize || null,
      track.addedAt,
      track.lastPlayedAt || null,
      track.playCount,
      track.liked ? 1 : 0,
    ])
  }

  async getAllTracks(): Promise<Track[]> {
    const rows = await this.query<TrackRow>(
      'SELECT * FROM tracks ORDER BY artist, album, track_number, title'
    )
    return rows.map(rowToTrack)
  }

  async getTrackById(id: string): Promise<Track | null> {
    const rows = await this.query<TrackRow>('SELECT * FROM tracks WHERE id = ?', [id])
    return rows[0] ? rowToTrack(rows[0]) : null
  }

  /** 按 path 查询曲目，供扫描时复用已有记录（移动端 scanner 用 path 作为主键查询） */
  async getTrackByPath(filePath: string): Promise<Track | null> {
    const rows = await this.query<TrackRow>('SELECT * FROM tracks WHERE path = ?', [filePath])
    return rows[0] ? rowToTrack(rows[0]) : null
  }

  async getTracksByAlbum(album: string, artist: string): Promise<Track[]> {
    const rows = await this.query<TrackRow>(
      'SELECT * FROM tracks WHERE album = ? AND artist = ? ORDER BY track_number',
      [album, artist]
    )
    return rows.map(rowToTrack)
  }

  async searchTracks(query: string): Promise<Track[]> {
    const q = `%${query}%`
    const rows = await this.query<TrackRow>(
      'SELECT * FROM tracks WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? ORDER BY title',
      [q, q, q]
    )
    return rows.map(rowToTrack)
  }

  async updateTrack(id: string, updates: Partial<Track>): Promise<void> {
    // 列名映射（与桌面端一致）
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
    const sets: string[] = []
    const values: any[] = []
    for (const [key, value] of Object.entries(updates)) {
      const col = UPDATABLE_COLUMNS[key]
      if (!col) continue
      sets.push(`${col} = ?`)
      values.push(key === 'liked' ? (value ? 1 : 0) : value ?? null)
    }
    if (sets.length === 0) return
    values.push(id)
    await this.run(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  async deleteTrack(id: string): Promise<void> {
    await this.run('DELETE FROM tracks WHERE id = ?', [id])
  }

  async insertAlbum(album: Album): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO albums (id, name, artist, cover_path, year) VALUES (?, ?, ?, ?, ?)`,
      [album.id, album.name, album.artist || null, album.coverPath || null, album.year || null]
    )
  }

  async getAllAlbums(): Promise<Album[]> {
    const rows = await this.query<AlbumRow>('SELECT * FROM albums ORDER BY name')
    return rows.map(rowToAlbum)
  }

  async getAlbumById(id: string): Promise<Album | null> {
    const rows = await this.query<AlbumRow>('SELECT * FROM albums WHERE id = ?', [id])
    return rows[0] ? rowToAlbum(rows[0]) : null
  }

  async insertPlaylist(playlist: Playlist): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [playlist.id, playlist.name, playlist.createdAt, playlist.updatedAt]
    )
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    const rows = await this.query<{ id: string; name: string; created_at: number; updated_at: number }>(
      'SELECT * FROM playlists ORDER BY updated_at DESC'
    )
    // playlist_tracks 关联表读取
    const result: Playlist[] = []
    for (const r of rows) {
      const tracks = await this.query<{ track_id: string; position: number }>(
        'SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
        [r.id]
      )
      result.push({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        trackIds: tracks.map((t) => t.track_id),
      })
    }
    return result
  }

  async getPlaylistById(id: string): Promise<Playlist | null> {
    const rows = await this.query<{ id: string; name: string; created_at: number; updated_at: number }>(
      'SELECT * FROM playlists WHERE id = ?',
      [id]
    )
    if (!rows[0]) return null
    const tracks = await this.query<{ track_id: string; position: number }>(
      'SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
      [id]
    )
    return {
      id: rows[0].id,
      name: rows[0].name,
      createdAt: rows[0].created_at,
      updatedAt: rows[0].updated_at,
      trackIds: tracks.map((t) => t.track_id),
    }
  }

  async updatePlaylist(id: string, updates: Partial<Playlist>): Promise<void> {
    const sets: string[] = []
    const values: any[] = []
    if (updates.name !== undefined) {
      sets.push('name = ?')
      values.push(updates.name)
    }
    if (updates.updatedAt !== undefined) {
      sets.push('updated_at = ?')
      values.push(updates.updatedAt)
    }
    if (sets.length > 0) {
      values.push(id)
      await this.run(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`, values)
    }
    // trackIds 更新：清空重插
    if (updates.trackIds !== undefined) {
      await this.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [id])
      if (updates.trackIds.length > 0) {
        for (let i = 0; i < updates.trackIds.length; i++) {
          await this.run(
            'INSERT OR REPLACE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)',
            [id, updates.trackIds[i], i]
          )
        }
      }
    }
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.run('DELETE FROM playlists WHERE id = ?', [id])
  }

  async getLikedTracks(): Promise<Track[]> {
    const rows = await this.query<TrackRow>('SELECT * FROM tracks WHERE liked = 1 ORDER BY title')
    return rows.map(rowToTrack)
  }

  async getRecentlyPlayed(limit = 50): Promise<Track[]> {
    const rows = await this.query<TrackRow>(
      'SELECT * FROM tracks WHERE last_played_at IS NOT NULL ORDER BY last_played_at DESC LIMIT ?',
      [limit]
    )
    return rows.map(rowToTrack)
  }

  async getMostPlayed(limit = 50): Promise<Track[]> {
    const rows = await this.query<TrackRow>(
      'SELECT * FROM tracks WHERE play_count > 0 ORDER BY play_count DESC LIMIT ?',
      [limit]
    )
    return rows.map(rowToTrack)
  }

  /** 扫描时清理 rootPath 范围内已不存在的曲目记录（与桌面端 database.ts 行为一致） */
  async deleteTracksWithMissingFiles(rootPath: string, existingPaths: ReadonlySet<string>): Promise<number> {
    const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'
    // 用 LIKE 取前缀范围内的记录（避免全表加载到 JS 层），再用 startsWith 精确校验
    const rows = await this.query<{ id: string; path: string; cover_path: string | null }>(
      'SELECT id, path, cover_path FROM tracks WHERE path LIKE ?',
      [prefix + '%']
    )
    const stale = rows.filter((r) => r.path.startsWith(prefix) && !existingPaths.has(r.path))
    if (stale.length === 0) return 0
    for (const t of stale) {
      await this.run('DELETE FROM tracks WHERE id = ?', [t.id])
    }
    return stale.length
  }

  /** 应用退出时关闭连接 */
  async close(): Promise<void> {
    if (dbConn) {
      try {
        await dbConn.close()
      } catch (err) {
        console.warn('[MobileDB] 关闭失败:', err)
      }
    }
    if (sqlite) {
      try {
        await sqlite.closeConnection(DB_NAME, false)
      } catch {
        // 忽略关闭连接失败
      }
    }
  }
}
