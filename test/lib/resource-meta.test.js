const { dropEdsWidgetDomains } = require('../../actions/lib/resource-meta.js')

describe('dropEdsWidgetDomains', () => {
    const config = () => ({
        actions: [
            { name: 'search-shop-products', resource_meta: { ui: { domain: 'https://main--masterclass-demo--znikolovski.aem.live', csp: { connectDomains: ['https://x.aem.live'] } } } },
            { name: 'get-shop-cart', resource_meta: { domain: 'main--masterclass-demo--znikolovski.aem.page', prefersBorder: false } },
            { name: 'build_gear_checklist', resource_meta: { ui: { prefersBorder: false } } },
            { name: 'custom', resource_meta: { ui: { domain: 'https://widgets.example.com' } } },
            { name: 'tool-only' }
        ]
    })

    test('drops EDS site origins used as the widget sandbox domain', () => {
        const c = config()
        expect(dropEdsWidgetDomains(c)).toEqual(['search-shop-products', 'get-shop-cart'])
        expect(c.actions[0].resource_meta.ui).toEqual({ csp: { connectDomains: ['https://x.aem.live'] } })
        expect(c.actions[1].resource_meta).toEqual({ prefersBorder: false })
    })

    test('keeps other domains and tolerates missing metadata', () => {
        const c = config()
        dropEdsWidgetDomains(c)
        expect(c.actions[3].resource_meta.ui.domain).toBe('https://widgets.example.com')
        expect(c.actions[4]).toEqual({ name: 'tool-only' })
        expect(dropEdsWidgetDomains({})).toEqual([])
        expect(dropEdsWidgetDomains(undefined)).toEqual([])
    })
})
