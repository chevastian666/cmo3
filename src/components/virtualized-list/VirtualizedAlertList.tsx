import React, { memo, useCallback, useEffect, useRef } from 'react'
import { useInfiniteLoading, useAlertSubscription } from './hooks/useInfiniteLoading'
import { useVirtualization } from './hooks/useVirtualization'
import { useAlertFiltering } from './hooks/useAlertFiltering'
import { AlertListItem } from './components/AlertListItem'
import { LoadingIndicator } from './components/LoadingIndicator'
import { EmptyState } from './components/EmptyState'
import { cn } from '../../utils/utils'
import type { Alert } from './types/alerts'
import type { Alerta } from '@/types/monitoring'
import type { VirtualizedAlertListProps } from './types/virtualization'

export const VirtualizedAlertList: React.FC<VirtualizedAlertListProps> = ({
  alerts: initialAlerts, 
  itemHeight = 80, 
  containerHeight, 
  overscan = 5, 
  onItemClick, 
  onLoadMore, 
  groupingOptions: _groupingOptions, 
  filters: initialFilters, 
  className
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  
  // Infinite loading
  const { items: loadedAlerts, hasMore, isLoading } = useInfiniteLoading({
    loadMore: onLoadMore || (async () => ({ 
      alerts: (initialAlerts || []).map(alert => ({
        id: alert.id,
        timestamp: new Date(alert.timestamp),
        severity: alert.severidad === 'critica' ? 'critical' : alert.severidad === 'alta' ? 'high' : alert.severidad === 'media' ? 'medium' : 'low',
        precintoId: alert.precintoId,
        location: {
          lat: alert.ubicacion?.lat || 0,
          lng: alert.ubicacion?.lng || 0,
          address: ''
        },
        message: alert.mensaje,
        status: alert.atendida ? 'resolved' : 'active'
      } as Alert)), 
      hasMore: false 
    }))
  })
  
  // Use loaded alerts or initial alerts
  const alerts = onLoadMore ? (loadedAlerts as unknown as Alerta[]) : (initialAlerts || [])
  
  // Filtering
  const {
    filteredAlerts,
    filters: _filters,
    updateFilters: _updateFilters,
    resetFilters,
    filterCount,
    isFiltering,
    highlightedIndices
  } = useAlertFiltering({
    alerts: alerts as unknown as Alert[],
    initialFilters,
    debounceMs: 100
  })

  // Virtualization
  const {
    containerProps,
    scrollerProps,
    visibleItems,
    state,
    scrollToItem,
    updateItemHeight,
    isScrolling,
    scrollDirection,
    getPerformanceMetrics
  } = useVirtualization({
    items: filteredAlerts,
    itemHeight,
    containerHeight,
    overscan,
    onScroll: (scrollTop, scrollHeight, clientHeight) => {
      if (onLoadMore && !isLoading && hasMore) {
        const threshold = scrollHeight - clientHeight - 200
        if (scrollTop >= threshold) {
          onLoadMore()
        }
      }
    }
  })

  // Subscribe to real-time updates
  useAlertSubscription(
    (_newItems: Alert[]) => {
      // Handle new items
    },
    (_updatedItem: Alert) => {
      // Handle updated item
    },
    (_itemId: string) => {
      // Handle removed item
    }
  )

  // Monitor performance
  useEffect(() => {
    const interval = setInterval(() => {
      const metrics = getPerformanceMetrics()
      if (metrics.fps < 30) {
        console.warn('Performance degradation detected:', metrics)
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [getPerformanceMetrics])

  // Render item with memoization
  const renderItem = useCallback((item: Alert, index: number, style: React.CSSProperties) => {
    const isHighlighted = highlightedIndices.has(index)
    return (
      <AlertListItem
        key={item.id}
        alert={item}
        index={index}
        style={style}
        onClick={() => onItemClick?.(item, index)}
        isHighlighted={isHighlighted}
        isScrolling={isScrolling}
        onHeightChange={(height) => updateItemHeight(index, height)}
      />
    )
  }, [highlightedIndices, onItemClick, isScrolling, updateItemHeight])

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const currentIndex = state.visibleRange[0]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        scrollToItem(Math.min(currentIndex + 1, filteredAlerts.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        scrollToItem(Math.max(currentIndex - 1, 0))
        break
      case 'PageDown':
        e.preventDefault()
        scrollToItem(Math.min(currentIndex + 10, filteredAlerts.length - 1))
        break
      case 'PageUp':
        e.preventDefault()
        scrollToItem(Math.max(currentIndex - 10, 0))
        break
      case 'Home':
        e.preventDefault()
        scrollToItem(0)
        break
      case 'End':
        e.preventDefault()
        scrollToItem(filteredAlerts.length - 1)
        break
    }
  }, [state.visibleRange, scrollToItem, filteredAlerts.length])

  // Error state
  const error = null // Replace with actual error state
  
  if (isLoading && alerts.length === 0) {
    return (
      <div className={cn('flex items-center justify-center', className)} style={{ height: containerHeight }}>
        <LoadingIndicator size="large" message="Cargando alertas..." />
      </div>
    )
  }

  // Error state
  if (error && alerts.length === 0) {
    return (
      <div className={cn('flex items-center justify-center', className)} style={{ height: containerHeight }}>
        <EmptyState
          title="Error al cargar alertas"
          message={error.message}
          action={{
            label: 'Reintentar',
            onClick: () => {}
          }}
        />
      </div>
    )
  }

  // Empty state
  if (filteredAlerts.length === 0 && !isFiltering) {
    return (
      <div className={cn('flex items-center justify-center', className)} style={{ height: containerHeight }}>
        <EmptyState
          title="No hay alertas"
          description={filterCount > 0 ? 'No se encontraron alertas con los filtros aplicados' : 'No hay alertas para mostrar'}
          action={filterCount > 0 ? {
            label: 'Limpiar filtros',
            onClick: resetFilters
          } : undefined}
        />
      </div>
    )
  }

  return (
    <div className={cn('relative', className)}>
      {/* Performance indicator */}
      {process.env.NODE_ENV === 'development' && (
        <div className="absolute top-2 right-2 z-10 bg-black/80 text-white text-xs p-2 rounded">
          <div>Items: {filteredAlerts.length} / {alerts.length}</div>
          <div>Visible: {state.visibleRange[0]}-{state.visibleRange[1]}</div>
          <div>Scroll: {scrollDirection || 'idle'}</div>
        </div>
      )}

      {/* Filter summary */}
      {filterCount > 0 && (
        <div className="absolute top-2 left-2 z-10 bg-blue-600 text-white text-sm px-3 py-1 rounded-full">
          {filterCount} filtro{filterCount > 1 ? 's' : ''} activo{filterCount > 1 ? 's' : ''}
        </div>
      )}

      {/* Virtual list container */}
      <div
        {...containerProps}
        className={cn(
          'overflow-auto scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-800',
          isScrolling && 'scroll-smooth'
        )}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="list"
        aria-label="Lista de alertas"
        aria-rowcount={filteredAlerts.length}
      >
        <div {...scrollerProps}>
          {visibleItems.map(({ item, index, style }) => renderItem(item as Alert, index, style))}
        </div>

        {/* Loading more indicator */}
        {isLoading && (
          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-gray-900">
            <LoadingIndicator size="small" message="Cargando más alertas..." />
          </div>
        )}

        {/* End of list */}
        {!hasMore && filteredAlerts.length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 p-4 text-center text-gray-500 text-sm">
            Fin de la lista • {filteredAlerts.length} alertas
          </div>
        )}
      </div>
    </div>
  )
}

// Export memoized version
export default memo(VirtualizedAlertList)