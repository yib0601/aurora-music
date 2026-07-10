import { useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'

export function SearchPage() {
  const [query, setQuery] = useState('')

  return (
    <div className="flex flex-col h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-4">搜索</h1>
        <div className="relative max-w-xl">
          <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-foreground/40" />
          <input
            type="text"
            placeholder="搜索歌曲、艺术家、专辑..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="glass rounded-xl w-full pl-12 pr-4 py-3 text-base outline-none focus:ring-2 focus:ring-primary/50"
            autoFocus
          />
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center text-foreground/30">
        <p>{query ? '未找到结果' : '输入关键词开始搜索'}</p>
      </div>
    </div>
  )
}
