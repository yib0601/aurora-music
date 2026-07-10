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
  db = new Database(dbPath)
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

export function insertTrack(track: Track): void {
  const d = getDb()
  d.prepare(`
    INSERT OR REPLACE INTO tracks (id, path, title, artist, album, year, genre, duration, track_number, cover_path, file_size, added_at, last_played_at, play_count, liked)
    VALUES (@id, @path, @title, @artist, @album, @year, @genre, @duration, @trackNumber, @coverPath, @fileSize, @addedAt, @lastPlayedAt, @playCount, @liked)
  `).run({
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

export function getAllTracks(): Track[] {
  const d = getDb()
  return d.prepare('SELECT * FROM tracks ORDER BY artist, album, track_number, title').all().map(rowToTrack)
}

export function getTrackById(id: string): Track | null {
  const d = getDb()
  const row = d.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as any
  return row ? rowToTrack(row) : null
}

export function getTrackByPath(p: string): Track | null {
  const d = getDb()
  const row = d.prepare('SELECT * FROM tracks WHERE path = ?').get(p) as any
  return row ? rowToTrack(row) : null
}

export function searchTracks(query: string): Track[] {
  const d = getDb()
  const q = `%${query}%`
  return d.prepare(`
    SELECT * FROM tracks WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY title
  `).all(q, q, q).map(rowToTrack)
}

export function updateTrack(id: string, updates: Partial<Track>): void {
  const d = getDb()
  const fields = Object.keys(updates).map((k) => {
    const col = camelToSnake(k)
    return `${col} = @${k}`
  })
  if (fields.length === 0) return
  const stmt = d.prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = @id`)
  stmt.run({ id, ...updates, liked: updates.liked !== undefined ? (updates.liked ? 1 : 0) : undefined })
}

export function deleteTrack(id: string): void {
  const d = getDb()
  d.prepare('DELETE FROM tracks WHERE id = ?').run(id)
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

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
}
