import type { PickupStoreGateway, PickupStoreQuery } from '../ports.js';
import { failure } from '../domain/index.js';
import type { PickupStores, Result, ToolError } from '../domain/index.js';
import type { StorefrontClient } from './storefront.js';
import { parsePickupStores } from '../parsers/stores.js';
import { STOREFRONT_ORIGIN } from '../parsers/catalog.js';
import { responseStatus } from './policy.js';
import { RequestStopped, requestTimeout } from '../session/request.js';

const STORE_SEARCH_PATH = '/on/demandware.store/Sites-continente-Site/default/Stores-GetStores?isQuerySearch=true';
const POSTAL_CODE = /^\d{4}-\d{3}$/;

/** Read store locator results through the observed AJAX GET contract, without setting store context. */
export class PickupStoresClient implements PickupStoreGateway {
  constructor(private readonly site: StorefrontClient) {}
  async fetchPickupStores(query: PickupStoreQuery): Promise<Result<PickupStores, ToolError>> {
    if (!POSTAL_CODE.test(query.postalCode)) return failure('invalid_input', 'postalCode must use the Portuguese format NNNN-NNN');
    if (!Number.isFinite(query.latitude) || query.latitude < -90 || query.latitude > 90 ||
      !Number.isFinite(query.longitude) || query.longitude < -180 || query.longitude > 180) {
      return failure('invalid_input', 'latitude and longitude must be valid geographic coordinates');
    }
    const params = new URLSearchParams({ deliveryLocation: query.postalCode, deliveryPostalCode: query.postalCode,
      latitude: String(query.latitude), longitude: String(query.longitude), searchLatitude: String(query.latitude), searchLongitude: String(query.longitude) });
    if (query.city?.trim()) params.set('city', query.city.trim());
    try {
      const lease = await this.site.session.ensureReady();
      const url = `${STOREFRONT_ORIGIN}${STORE_SEARCH_PATH}&${params}`;
      const response = await this.site.io(lease, () => lease.context.request.get(url, {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${STOREFRONT_ORIGIN}/` },
        timeout: requestTimeout(10000), maxRedirects: 0,
      }));
      const status = responseStatus(response, response.url?.() ?? url);
      if (!status.ok) return status;
      const html = await this.site.io(lease, () => response.text());
      return parsePickupStores(html);
    } catch (error) {
      if (error instanceof RequestStopped) return failure(error.code);
      return failure('upstream_unavailable', 'The store locator response could not be read');
    }
  }
}
