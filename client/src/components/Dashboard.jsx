import React, { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAccounts, useDashboardData, useVersion, useDeleteAccount } from '@/hooks/useZeabur'
import { AccountCard } from './AccountCard'
import { AddAccountDialog } from './AddAccountDialog'
import { LogsDialog } from './LogsDialog'
import { Button } from '@/components/ui/button'
import { LogOut, Plus, RefreshCw, Trash2, LayoutGrid, Github, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import toast from 'react-hot-toast'

function Dashboard() {
  const { logout } = useAuth()
  const [showAdd, setShowAdd] = useState(false)
  const [showManage, setShowManage] = useState(false)
  
  // Logs state
  const [logsOpen, setLogsOpen] = useState(false)
  const [selectedService, setSelectedService] = useState(null)

  const { data: accountsList } = useAccounts()
  const { data: dashboardData, isLoading, refetch, isRefetching } = useDashboardData(accountsList)
  const { data: version } = useVersion()
  const { mutate: deleteAccount } = useDeleteAccount()

  const handleLogs = (service, project, account) => {
    setSelectedService({ ...service, projectName: project.name, accountToken: account.token })
    setLogsOpen(true)
  }

  // Calculate Summary
  const stats = dashboardData?.reduce((acc, curr) => {
    const projects = curr.projects || []
    acc.projects += projects.length
    projects.forEach(p => {
      acc.services += p.services?.length || 0
      acc.running += p.services?.filter(s => s.status === 'RUNNING').length || 0
      acc.cost += p.cost || 0
    })
    return acc
  }, { projects: 0, services: 0, running: 0, cost: 0 }) || { projects: 0, services: 0, running: 0, cost: 0 }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 pb-20">
      {/* Header */}
      <header className="sticky top-0 z-40 w-full border-b bg-white/80 dark:bg-slate-900/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
        <div className="container flex h-16 items-center space-x-4 sm:justify-between sm:space-x-0 mx-auto px-4">
          <div className="flex gap-2 items-center text-primary font-bold text-xl tracking-tight">
            <LayoutGrid className="h-6 w-6" />
            Zeabur Monitor
          </div>
          <div className="flex flex-1 items-center justify-end space-x-2">
            <Button variant="ghost" size="sm" onClick={() => window.open('https://github.com/jiujiu532/zeabur-monitor', '_blank')}>
              <Github className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
            <div className="hidden md:flex items-center text-xs text-muted-foreground bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full">
              v{version?.current || '...'} 
              {version?.latest && version.latest !== version.current && (
                <span className="ml-2 text-orange-500 font-bold">New: {version.latest}</span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowManage(true)}>
              管理账号
            </Button>
            <Button variant="ghost" size="icon" onClick={logout} title="退出登录">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Actions & Summary */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
           <div className="flex gap-2">
             <Button onClick={refetch} disabled={isRefetching} variant="outline" className={isRefetching ? "animate-pulse" : ""}>
               <RefreshCw className={isRefetching ? "h-4 w-4 mr-2 animate-spin" : "h-4 w-4 mr-2"} />
               刷新数据
             </Button>
             <Button onClick={() => setShowAdd(true)}>
               <Plus className="h-4 w-4 mr-2" />
               添加账号
             </Button>
           </div>
           
           {/* Summary Cards */}
           <div className="grid grid-cols-4 gap-4 bg-white dark:bg-slate-900 p-2 rounded-xl border shadow-sm w-full md:w-auto text-center">
             <div className="px-4">
               <div className="text-xs text-muted-foreground uppercase">Projects</div>
               <div className="font-bold text-lg">{stats.projects}</div>
             </div>
             <div className="px-4 border-l">
               <div className="text-xs text-muted-foreground uppercase">Services</div>
               <div className="font-bold text-lg">{stats.services}</div>
             </div>
             <div className="px-4 border-l">
               <div className="text-xs text-muted-foreground uppercase">Running</div>
               <div className="font-bold text-lg text-green-500">{stats.running}</div>
             </div>
             <div className="px-4 border-l">
               <div className="text-xs text-muted-foreground uppercase">Cost</div>
               <div className="font-bold text-lg text-blue-500">${stats.cost.toFixed(2)}</div>
             </div>
           </div>
        </div>

        {/* Content */}
        {isLoading && !dashboardData ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-10 w-10 animate-spin text-primary/50" />
          </div>
        ) : (
          <div>
            {dashboardData?.map((account) => (
              <AccountCard 
                key={account.name} 
                account={account} 
                onLogs={(service) => handleLogs(service, {name: 'Project'}, account)} // Project name passed down is cleaner but this works
              />
            ))}
            
            {(!dashboardData || dashboardData.length === 0) && (
              <div className="text-center py-20 bg-slate-50 dark:bg-slate-900 rounded-xl border border-dashed">
                <h3 className="text-lg font-semibold text-muted-foreground">暂无账号</h3>
                <p className="text-sm text-slate-400 mb-4">添加一个 Zeabur 账号以开始监控</p>
                <Button onClick={() => setShowAdd(true)}>立即添加</Button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Dialogs */}
      <AddAccountDialog open={showAdd} onOpenChange={setShowAdd} />
      <LogsDialog 
        open={logsOpen} 
        onOpenChange={setLogsOpen} 
        serviceInfo={selectedService} 
      />
      
      {/* Manage Accounts Dialog (Simple List) */}
      <Dialog open={showManage} onOpenChange={setShowManage} title="管理账号">
        <div className="space-y-4">
           {accountsList?.map((acc, idx) => (
             <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg border">
               <div>
                 <div className="font-medium">{acc.name}</div>
                 <div className="text-xs text-muted-foreground truncate max-w-[200px]">{acc.email || '***'}</div>
               </div>
               <Button 
                 variant="destructive" 
                 size="sm" 
                 onClick={() => {
                   if(confirm('确认删除?')) deleteAccount(idx)
                 }}
               >
                 <Trash2 className="h-4 w-4" />
               </Button>
             </div>
           ))}
           {(!accountsList || accountsList.length === 0) && <div className="text-center text-muted-foreground">暂无账号</div>}
        </div>
      </Dialog>
    </div>
  )
}

export default Dashboard
