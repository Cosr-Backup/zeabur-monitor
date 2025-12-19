import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/lib/api'
import toast from 'react-hot-toast'

// Accounts
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const res = await api.get('/server-accounts')
      return res.data
    },
    staleTime: 1000 * 60 * 5, // 5 mins
  })
}

export function useAddAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, token }) => {
      // First validate
      const validRes = await api.post('/validate-account', { accountName: name, apiToken: token })
      if (!validRes.data.success) throw new Error(validRes.data.error)
      
      // Then add to list (we need to fetch current list first or optimistically update)
      // The backend API for /server-accounts expects the FULL list
      // So we usually fetch, push, then save.
      // But for simplicity in this hook, let's assume the UI handles the "list building" 
      // OR we implement a proper "add one" pattern if backend supported it.
      // Backend: POST /api/server-accounts expects { accounts: [...] }
      
      // Let's refactor the backend interaction logic in the component or here. 
      // Better to do it here for "add single".
      
      // 1. Get current list
      const currentList = queryClient.getQueryData(['accounts']) || []
      const newList = [...currentList, { name, token, email: validRes.data.userData.email }]
      
      // 2. Save full list
      return api.post('/server-accounts', { accounts: newList })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }) // Invalidate dashboard data
      toast.success('账号添加成功')
    },
    onError: (err) => {
      toast.error(err.message || '添加失败')
    }
  })
}

export function useDeleteAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (index) => {
      return api.delete(`/server-accounts/${index}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success('账号已删除')
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || '删除失败')
    }
  })
}

// Dashboard Data (Accounts + Projects combined logic from old frontend)
export function useDashboardData(accounts) {
  return useQuery({
    queryKey: ['dashboard', accounts], // Depend on accounts list
    queryFn: async () => {
      if (!accounts || accounts.length === 0) return []

      // Strip extra data for the request
      const accountsPayload = accounts.map(a => ({ name: a.name, token: a.token }))

      // Parallel fetch like in old frontend
      const [accountsRes, projectsRes] = await Promise.all([
        api.post('/temp-accounts', { accounts: accountsPayload }),
        api.post('/temp-projects', { accounts: accountsPayload, projectCosts: {} })
      ])

      // Merge data - 保留原始 token 用于后续 API 调用
      return accountsRes.data.map((acc, index) => ({
        ...acc,
        token: accounts[index]?.token, // 保留原始 token
        projects: projectsRes.data[index]?.projects || []
      }))
    },
    enabled: !!accounts && accounts.length > 0,
    refetchInterval: 90000, // 90s auto refresh
  })
}

// Service Actions
export function useServiceAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ action, token, serviceId, environmentId }) => {
      // action: 'pause' or 'restart'
      const endpoint = action === 'pause' ? '/service/pause' : '/service/restart'
      return api.post(endpoint, { token, serviceId, environmentId })
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success(variables.action === 'pause' ? '服务已暂停' : '服务已重启')
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || '操作失败')
    }
  })
}

// Logs
export function useServiceLogs() {
  return useMutation({
    mutationFn: async ({ token, serviceId, environmentId, projectId }) => {
      const res = await api.post('/service/logs', { token, serviceId, environmentId, projectId, limit: 200 })
      return res.data
    }
  })
}

// Project Rename
export function useRenameProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ accountId, projectId, newName }) => {
      return api.post('/project/rename', { accountId, projectId, newName })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success('项目重命名成功')
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || '重命名失败')
    }
  })
}

export function useVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: async () => {
      const [curr, latest] = await Promise.all([
        api.get('/version'),
        api.get('/latest-version').catch(() => ({ data: { version: '--' } }))
      ])
      return { current: curr.data.version, latest: latest.data.version }
    }
  })
}
