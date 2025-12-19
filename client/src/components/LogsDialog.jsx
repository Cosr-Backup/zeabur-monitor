import React, { useState, useEffect, useRef } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useServiceLogs } from '@/hooks/useZeabur'
import { Loader2, Copy } from 'lucide-react'
import toast from 'react-hot-toast'

export function LogsDialog({ open, onOpenChange, serviceInfo }) {
  const { mutate: fetchLogs, isPending } = useServiceLogs()
  const [logs, setLogs] = useState([])
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (open && serviceInfo) {
      setLogs([])
      setError(null)
      fetchLogs({
        token: serviceInfo.token,
        serviceId: serviceInfo.serviceId,
        environmentId: serviceInfo.environmentId,
        projectId: serviceInfo.projectId
      }, {
        onSuccess: (data) => {
          if (data.logs) {
            setLogs(data.logs)
          } else {
            setError('无日志数据')
          }
        },
        onError: (err) => {
          setError(err.message || '获取日志失败')
        }
      })
    }
  }, [open, serviceInfo, fetchLogs])

  // Scroll to bottom when logs load
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  const copyLogs = () => {
    const text = logs.map(l => `[${new Date(l.timestamp).toLocaleString()}] ${l.message}`).join('\n')
    navigator.clipboard.writeText(text)
    toast.success('日志已复制')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`📜 日志 - ${serviceInfo?.name || 'Service'}`} className="max-w-4xl h-[80vh] flex flex-col">
      <div className="bg-slate-800 text-slate-300 text-xs p-2 rounded-t flex gap-4 shrink-0">
        <span>项目: {serviceInfo?.projectName}</span>
        <span>服务: {serviceInfo?.name}</span>
        <span className="ml-auto">{logs.length} 条记录</span>
        <Button variant="ghost" size="icon" className="h-4 w-4 text-white hover:text-primary" onClick={copyLogs} title="复制所有">
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      
      <div className="flex-1 bg-slate-950 p-4 overflow-y-auto font-mono text-xs text-slate-300 rounded-b border border-slate-800">
        {isPending ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p>正在拉取日志...</p>
          </div>
        ) : error ? (
          <div className="text-red-400 p-4 text-center">{error}</div>
        ) : logs.length === 0 ? (
          <div className="text-center text-muted-foreground p-10">暂无日志</div>
        ) : (
          <div className="space-y-1">
            {logs.map((log, i) => (
              <div key={i} className="break-all whitespace-pre-wrap hover:bg-white/5 p-0.5 rounded">
                <span className="text-slate-500 mr-2 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                <span>{log.message}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </Dialog>
  )
}
