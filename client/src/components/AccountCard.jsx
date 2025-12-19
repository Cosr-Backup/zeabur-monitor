import React, { useState } from 'react'
import { Card, CardHeader, CardContent, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronRight, ChevronDown, Play, Pause, RotateCw, FileText, Globe, Pencil, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useServiceAction, useRenameProject, useServiceLogs } from '@/hooks/useZeabur'
import { Dialog } from '@/components/ui/dialog'
import toast from 'react-hot-toast'

const ServiceItem = ({ service, account, project, onLogs }) => {
  const { mutate: performAction, isPending } = useServiceAction()

  const handleAction = (action) => {
    if (!confirm(`确定要${action === 'pause' ? '暂停' : '重启'}服务 "${service.name}" 吗?`)) return
    
    const envId = project.environments?.[0]?._id
    if (!envId) return toast.error('无法获取环境ID')

    performAction({
      action,
      token: account.token,
      serviceId: service._id,
      environmentId: envId
    })
  }

  const statusColor = {
    RUNNING: 'success',
    SUSPENDED: 'destructive',
    CRASHED: 'destructive',
    DEPLOYING: 'warning',
    building: 'warning'
  }[service.status] || 'secondary'

  return (
    <div className="group flex flex-col gap-2 p-3 rounded-lg border bg-slate-50/50 dark:bg-slate-900/50 hover:bg-white dark:hover:bg-slate-800 transition-all shadow-sm hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm truncate" title={service.name}>{service.name}</span>
        <Badge variant={statusColor} className="text-[10px] px-1.5 py-0 h-5">
          {service.status}
        </Badge>
      </div>
      
      <div className="flex gap-1 mt-auto opacity-80 group-hover:opacity-100 transition-opacity">
        {service.status === 'RUNNING' && (
          <Button 
            variant="outline" 
            size="icon" 
            className="h-6 w-6" 
            title="暂停"
            disabled={isPending}
            onClick={() => handleAction('pause')}
          >
            <Pause className="h-3 w-3" />
          </Button>
        )}
        <Button 
          variant="outline" 
          size="icon" 
          className="h-6 w-6" 
          title={service.status === 'SUSPENDED' ? '启动' : '重启'}
          disabled={isPending}
          onClick={() => handleAction('restart')}
        >
          {service.status === 'SUSPENDED' ? <Play className="h-3 w-3" /> : <RotateCw className="h-3 w-3" />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-6 w-6"
          title="日志"
          onClick={() => onLogs({
            name: service.name,
            token: account.token,
            serviceId: service._id,
            environmentId: project.environments?.[0]?._id,
            projectId: project._id,
            projectName: project.name
          })}
        >
          <FileText className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}

const ProjectCard = ({ project, account, onLogs }) => {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(project.name)
  const { mutate: rename, isPending: isRenaming } = useRenameProject()

  const handleRename = () => {
    if (editName.trim() === project.name) {
      setIsEditing(false)
      return
    }
    rename({ 
      accountId: account.id || account.name, 
      projectId: project._id, 
      newName: editName 
    }, {
      onSuccess: () => setIsEditing(false)
    })
  }

  const domains = project.services?.flatMap(s => s.domains || []).filter(d => d.domain) || []
  const cost = project.cost || 0
  const runningCount = project.services?.filter(s => s.status === 'RUNNING').length || 0

  return (
    <div className="flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm hover:-translate-y-1 hover:shadow-lg transition-all duration-200 overflow-hidden relative group">
      {/* Decorative gradient background */}
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-pink-400 to-purple-400 opacity-70 group-hover:opacity-100 transition-opacity" />
      
      <div className="p-4 flex flex-col h-full">
        {/* Header */}
        <div className="flex justify-between items-start mb-3">
          <div className="flex-1 min-w-0 pr-2">
            {isEditing ? (
              <div className="flex items-center gap-1">
                <input 
                  className="w-full text-sm font-bold border rounded px-1 py-0.5 bg-background"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRename()
                    if (e.key === 'Escape') setIsEditing(false)
                  }}
                />
                <Button size="icon" variant="ghost" className="h-6 w-6 text-green-500" onClick={handleRename} disabled={isRenaming}><Check className="h-3 w-3" /></Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500" onClick={() => setIsEditing(false)}><X className="h-3 w-3" /></Button>
              </div>
            ) : (
              <div className="flex items-center gap-1 group/title">
                <h4 className="font-bold text-sm truncate" title={project.name}>{project.name}</h4>
                <Button 
                  size="icon" 
                  variant="ghost" 
                  className="h-5 w-5 opacity-0 group-hover/title:opacity-100 transition-opacity"
                  onClick={() => { setEditName(project.name); setIsEditing(true) }}
                >
                  <Pencil className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            )}
            <div className="text-xs text-muted-foreground flex gap-2 mt-1">
              <span>{project.region}</span>
              <span className={cn(runningCount > 0 ? "text-green-600" : "text-slate-400")}>
                {runningCount} 运行中
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="font-bold text-lg text-blue-600 dark:text-blue-400">
              ${cost < 0.01 && cost > 0 ? '0.01' : cost.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground">本月</div>
          </div>
        </div>

        {/* Services */}
        <div className="grid grid-cols-1 gap-2 mb-4 flex-1 content-start">
          {project.services?.length > 0 ? (
            project.services.map(service => (
              <ServiceItem key={service._id} service={service} account={account} project={project} onLogs={onLogs} />
            ))
          ) : (
            <div className="text-xs text-center text-muted-foreground py-4 bg-slate-50 dark:bg-slate-900 rounded border border-dashed">
              暂无服务
            </div>
          )}
        </div>

        {/* Domains */}
        {domains.length > 0 && (
          <div className="mt-auto pt-3 border-t grid gap-1">
            {domains.map((d, i) => (
              <a 
                key={i} 
                href={`https://${d.domain}`} 
                target="_blank" 
                rel="noreferrer"
                className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-primary transition-colors truncate bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded"
              >
                <Globe className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{d.domain}</span>
                {d.isGenerated && <span className="text-[9px] bg-slate-200 dark:bg-slate-700 px-1 rounded ml-auto">自动</span>}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export const AccountCard = ({ account, onLogs }) => {
  const [expanded, setExpanded] = useState(true)
  const credit = account.data?.credit || 0
  const balance = credit / 100
  
  // Balance color logic
  const balanceColor = balance < 0.1 ? 'text-red-500' : balance < 0.5 ? 'text-orange-500' : 'text-green-600'

  return (
    <div className="mb-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div 
        className="flex items-center justify-between p-3 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer hover:bg-white/80 dark:hover:bg-slate-900/80 transition-all mb-3 select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className={cn("transition-transform duration-300 text-muted-foreground", expanded && "rotate-90")}>
            <ChevronRight className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold text-lg flex items-center gap-2">
              {account.name}
              {account.error && <Badge variant="destructive" className="text-xs">Error</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">
              {account.data?.email ? (
                // Simple mask
                account.data.email.replace(/(^..).+(@.+)/, '$1***$2')
              ) : (
                account.data?.username || 'Loading...'
              )}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-4 text-right">
          {account.data && (
            <div>
              <div className={cn("text-xl font-bold font-mono", balanceColor)}>
                ${balance.toFixed(2)}
              </div>
              <div className="text-[10px] text-muted-foreground">余额</div>
            </div>
          )}
          {account.aihub?.balance !== undefined && (
            <div className="hidden sm:block px-3 py-1 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg text-white shadow-sm">
              <div className="font-bold text-sm">
                ${(account.aihub.balance / 100000).toFixed(2)}
              </div>
              <div className="text-[10px] opacity-80">AI Hub</div>
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pl-2", 
          !account.projects?.length && "flex justify-center"
        )}>
          {account.error ? (
            <div className="col-span-full p-4 text-destructive bg-destructive/10 rounded-lg text-sm">
              {account.error}
            </div>
          ) : account.projects?.length > 0 ? (
            account.projects.map(project => (
              <ProjectCard key={project._id} project={project} account={account} onLogs={onLogs} />
            ))
          ) : (
            <div className="col-span-full py-8 text-center text-muted-foreground bg-slate-50/50 dark:bg-slate-900/50 rounded-lg border border-dashed">
              暂无项目
            </div>
          )}
        </div>
      )}
    </div>
  )
}
