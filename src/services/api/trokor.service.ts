/**
 * Servicio principal para la API de Trokor
 * By Cheva
 */

import { TROKOR_CONFIG, getTrokorHeaders, buildTrokorUrl } from '../../config/trokor.config';
import { TrokorAdapter } from './trokor.adapter';
import { cacheService } from './cache.service';
import { notificationService } from '../shared/notification.service';
import type { 
  Transito, 
  TransitoPendiente, 
  Alerta, 
  PrecintoActivo,
  EstadisticasMonitoreo
} from '../../types';

class TrokorService {
  private readonly isEnabled = import.meta.env.VITE_USE_REAL_API === 'true';
  private readonly apiKey = import.meta.env.VITE_API_KEY;
  
  /**
   * Realiza una petición a la API de Trokor
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: any,
    params?: Record<string, any>
  ): Promise<T> {
    if (!this.isEnabled) {
      throw new Error('Trokor API no está habilitada');
    }
    
    if (!this.apiKey) {
      console.warn('API Key de Trokor no configurada');
    }
    
    const url = new URL(buildTrokorUrl(endpoint));
    
    // Agregar parámetros de query
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, value.toString());
        }
      });
    }
    
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: getTrokorHeaders(),
        body: body ? JSON.stringify(body) : undefined
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`Trokor API error: ${response.status}`, error);
        throw new Error(`API Error: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error en petición a Trokor:', error);
      throw error;
    }
  }
  
  // ==================== TRÁNSITOS ====================
  
  /**
   * Obtiene tránsitos pendientes desde Trokor
   */
  async getTransitosPendientes(params?: {
    limit?: number;
    offset?: number;
  }): Promise<TransitoPendiente[]> {
    const cacheKey = `trokor:transitos-pendientes:${JSON.stringify(params)}`;
    
    // Verificar caché
    const cached = cacheService.get<TransitoPendiente[]>(cacheKey);
    if (cached) return cached;
    
    try {
      const response = await this.request<any[]>(
        'GET',
        TROKOR_CONFIG.ENDPOINTS.VIAJES_PENDIENTES,
        undefined,
        params
      );
      
      // Transformar datos usando el adaptador
      const transitos = response.map(data => TrokorAdapter.transitoPendienteFromAux(data));
      
      // Cachear por 30 segundos
      cacheService.set(cacheKey, transitos, 30000);
      
      return transitos;
    } catch (error) {
      notificationService.error('Error al cargar tránsitos', 'No se pudo conectar con Trokor');
      return [];
    }
  }
  
  /**
   * Obtiene todos los tránsitos
   */
  async getTransitos(params?: {
    estado?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: Transito[]; total: number }> {
    try {
      // Obtener viajes desde Trokor
      const response = await this.request<{
        data: any[];
        total: number;
      }>('GET', TROKOR_CONFIG.ENDPOINTS.VIAJES, undefined, {
        page: params?.page || 1,
        limit: params?.limit || 25,
        status: params?.estado ? this.mapEstadoToTrokor(params.estado) : undefined
      });
      
      // Transformar cada viaje
      const transitos = await Promise.all(
        response.data.map(async (viaje) => {
          // Intentar obtener el precinto asociado
          let precinto = null;
          if (viaje.precintoid) {
            try {
              precinto = await this.request<any>(
                'GET',
                TROKOR_CONFIG.ENDPOINTS.PRECINTO_BY_NQR(viaje.precintoid)
              );
            } catch (e) {
              console.warn(`No se pudo obtener precinto ${viaje.precintoid}`);
            }
          }
          
          return TrokorAdapter.viajeToTransito(viaje, precinto);
        })
      );
      
      return {
        data: transitos,
        total: response.total
      };
    } catch (error) {
      console.error('Error al obtener tránsitos:', error);
      return { data: [], total: 0 };
    }
  }
  
  // ==================== PRECINTOS ====================
  
  /**
   * Obtiene precintos activos
   */
  async getPrecintosActivos(limit: number = 50): Promise<PrecintoActivo[]> {
    const cacheKey = `trokor:precintos-activos:${limit}`;
    
    const cached = cacheService.get<PrecintoActivo[]>(cacheKey);
    if (cached) return cached;
    
    try {
      // Estados 1 (en tránsito) y 3 (con alerta) se consideran activos
      const response = await this.request<{
        data: any[];
      }>('GET', TROKOR_CONFIG.ENDPOINTS.PRECINTOS_ACTIVOS, undefined, {
        limit,
        status: '1,3' // En tránsito o con alerta
      });
      
      // Obtener información adicional para cada precinto
      const precintosActivos = await Promise.all(
        response.data.map(async (precinto) => {
          // Intentar obtener el viaje asociado
          let viaje = null;
          try {
            const viajesResponse = await this.request<any[]>(
              'GET',
              TROKOR_CONFIG.ENDPOINTS.VIAJES,
              undefined,
              { precintoid: precinto.nqr, limit: 1 }
            );
            viaje = viajesResponse[0];
          } catch (e) {
            console.warn(`No se encontró viaje para precinto ${precinto.nqr}`);
          }
          
          // Intentar obtener ubicación
          let ubicacion = null;
          try {
            ubicacion = await this.request<any>(
              'GET',
              TROKOR_CONFIG.ENDPOINTS.UBICACION_BY_PRECINTO(precinto.precintoid)
            );
          } catch (e) {
            // Sin ubicación disponible
          }
          
          return TrokorAdapter.precintoToPrecintoActivo(precinto, viaje, ubicacion);
        })
      );
      
      // Cachear por 15 segundos
      cacheService.set(cacheKey, precintosActivos, 15000);
      
      return precintosActivos;
    } catch (error) {
      console.error('Error al obtener precintos activos:', error);
      notificationService.error('Error al cargar precintos', 'No se pudo conectar con Trokor');
      return [];
    }
  }
  
  // ==================== ALERTAS ====================
  
  /**
   * Obtiene alertas activas
   */
  async getAlertasActivas(params?: {
    page?: number;
    limit?: number;
  }): Promise<Alerta[]> {
    const cacheKey = `trokor:alertas-activas:${JSON.stringify(params)}`;
    
    const cached = cacheService.get<Alerta[]>(cacheKey);
    if (cached) return cached;
    
    try {
      const response = await this.request<{
        data: any[];
      }>('GET', TROKOR_CONFIG.ENDPOINTS.ALARMAS_ACTIVAS, undefined, params);
      
      // Transformar cada alarma
      const alertas = await Promise.all(
        response.data.map(async (alarma) => {
          // Obtener información del precinto y viaje
          let precinto = null;
          let viaje = null;
          
          if (alarma.precintoid) {
            try {
              const precintoResponse = await this.request<any[]>(
                'GET',
                TROKOR_CONFIG.ENDPOINTS.PRECINTOS,
                undefined,
                { precintoid: alarma.precintoid, limit: 1 }
              );
              precinto = precintoResponse[0];
              
              if (precinto) {
                // Buscar viaje asociado
                const viajeResponse = await this.request<any[]>(
                  'GET',
                  TROKOR_CONFIG.ENDPOINTS.VIAJES,
                  undefined,
                  { precintoid: precinto.nqr, limit: 1 }
                );
                viaje = viajeResponse[0];
              }
            } catch (e) {
              console.warn(`Error obteniendo datos para alarma ${alarma.asid}`);
            }
          }
          
          return TrokorAdapter.alarmaToAlerta(alarma, precinto, viaje);
        })
      );
      
      // Cachear por 10 segundos (las alertas son críticas)
      cacheService.set(cacheKey, alertas, 10000);
      
      return alertas;
    } catch (error) {
      console.error('Error al obtener alertas:', error);
      notificationService.error('Error al cargar alertas', 'No se pudo conectar con Trokor');
      return [];
    }
  }
  
  /**
   * Verifica una alerta
   */
  async verificarAlerta(alertaId: string, datos: {
    opcionRespuesta: number;
    comandos: string[];
    observaciones: string;
    verificadoPor: string;
  }): Promise<void> {
    try {
      await this.request(
        'POST',
        TROKOR_CONFIG.ENDPOINTS.ALARMA_VERIFICAR(alertaId),
        datos
      );
      
      // Limpiar caché de alertas
      cacheService.invalidatePattern('trokor:alertas');
      
      notificationService.success('Alerta verificada', 'La alerta ha sido procesada correctamente');
    } catch (error) {
      console.error('Error al verificar alerta:', error);
      throw new Error('No se pudo verificar la alerta');
    }
  }
  
  // ==================== ESTADÍSTICAS ====================
  
  /**
   * Obtiene estadísticas del dashboard
   */
  async getEstadisticas(): Promise<EstadisticasMonitoreo> {
    const cacheKey = 'trokor:estadisticas';
    
    const cached = cacheService.get<EstadisticasMonitoreo>(cacheKey);
    if (cached) return cached;
    
    try {
      const response = await this.request<any>(
        'GET',
        TROKOR_CONFIG.ENDPOINTS.ESTADISTICAS_DASHBOARD
      );
      
      const estadisticas: EstadisticasMonitoreo = {
        precintosActivos: response.precintos_activos || 0,
        alertasActivas: response.alertas_activas || 0,
        transitosEnCurso: response.transitos_en_curso || 0,
        tiempoPromedioTransito: response.tiempo_promedio_transito || 0,
        lecturasPorHora: response.lecturas_por_hora || 0,
        alertasPorHora: response.alertas_por_hora || 0,
        precintosConBateriaBaja: response.precintos_bateria_baja || 0
      };
      
      // Cachear por 1 minuto
      cacheService.set(cacheKey, estadisticas, 60000);
      
      return estadisticas;
    } catch (error) {
      console.error('Error al obtener estadísticas:', error);
      
      // Devolver valores por defecto
      return {
        precintosActivos: 0,
        alertasActivas: 0,
        transitosEnCurso: 0,
        tiempoPromedioTransito: 0,
        lecturasPorHora: 0,
        alertasPorHora: 0,
        precintosConBateriaBaja: 0
      };
    }
  }
  
  // ==================== HELPERS ====================
  
  /**
   * Mapea estado CMO a estado Trokor
   */
  private mapEstadoToTrokor(estado: string): number | undefined {
    const mapping: Record<string, number> = {
      'PENDIENTE': 0,
      'EN_TRANSITO': 1,
      'COMPLETADO': 2,
      'ALERTA': 3
    };
    
    return mapping[estado];
  }
  
  /**
   * Verifica si la API está disponible
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.request('GET', TROKOR_CONFIG.ENDPOINTS.SYSTEM_HEALTH);
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Exportar instancia singleton
export const trokorService = new TrokorService();