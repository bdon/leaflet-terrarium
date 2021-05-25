const hillshade = (input, a1,a2,a3) => {
    let temp = new Int16Array(260*260)
    for (var i = 0; i < temp.length; i ++) {
        temp[i] = (input[i*4] * 256 + input[i*4+1] + input[i*4+2] / 256) - 32768
    }
    let result = input
    for (var i = 0; i < temp.length; i ++) {
        result[i*4+3] = 255
        if (temp[i] <= 0) {
            result[i*4] = 255
            result[i*4+1] = 255
            result[i*4+2] = 255
            continue
        }
        let x = i % 260
        let y = Math.floor(i / 260)
        let z2 = temp[260*Math.max(0, y - 1)+x]
        let z4 = temp[260*y+Math.max(0, x - 1)]
        let z6 = temp[260*y+Math.min(260 - 1, x + 1)]
        let z8 = temp[260*Math.min(260, y + 1)+x]
        let dzdx = 0.2 * (z6 - z4) / 2
        let dzdy = 0.2 * (z2 - z8) / 2
        var L = (a1 - a2 * dzdx - a3 * dzdy) / Math.sqrt(1 + dzdx ** 2 + dzdy ** 2)
        if (L < 0) L = 0;
        L = Math.sqrt(L * .8 + .2)
        result[i*4] = Math.round(L * 255)
        result[i*4+1] = Math.round(L * 255)
        result[i*4+2] = Math.round(L * 255)
    }
    return result
}

class AbortError extends Error {
  constructor(message) {
    super(message)
    this.name = "AbortError"
  }
}

class ScratchPool {
    constructor(tile_size) {
        this.unused = []
        this.tile_size = tile_size
    }

    get(tile_size) {
        if (this.unused.length) {
            let free = this.unused.shift()
            free.removed = false
            return free
        }
        let element = L.DomUtil.create('canvas')
        element.width = this.tile_size
        element.height = this.tile_size
        return element
    }

    put(elem) {
        this.unused.push(elem)
    }
}

const loadImage = src => {
    let img = new Image()
    img.crossOrigin = "Anonymous"

    let p = new Promise((resolve,reject) => {
        img.src = src
        img.onload = () => resolve(img)
        img.onerror = () => {
            reject(new AbortError("Image cancel"))
        }
    })
    return {p:p,abort: () => { 
        img.src = ''
    }}
}

export class ZxySource {

    constructor(url) {
        this.url = url
        this.controllers = []
        this.scratch = new ScratchPool(260)
        this.currentZ = undefined
    }

    async get(c,azimuth,elevation) {
        this.currentZ = c.z
        this.controllers = this.controllers.filter(cont => {
            if (cont[0] != this.currentZ) {
                cont[1].abort()
                return false
            }
            return true
        })
        let url = this.url.replace("{z}",c.z.toString()).replace("{x}",c.x.toString()).replace("{y}",c.y.toString())
        let loader = loadImage(url)
        this.controllers.push([c.z,loader])
        let x = await loader.p
        if (this.currentZ != c.z) { 
            throw new AbortError("Cancel")
        }
        let scratch = this.scratch.get()
        let scratchCtx = scratch.getContext('2d')
        scratchCtx.drawImage(x,0,0,260,260)
        let data = scratchCtx.getImageData(0,0,260,260)

        let alpha = Math.PI / 180 * azimuth
        let beta = Math.PI / 180 * elevation
        let a1 = Math.sin(beta)
        let a2 = Math.cos(beta) * Math.sin(alpha)
        let a3 = Math.cos(beta) * Math.cos(alpha)
        let result = hillshade(data.data,a1,a2,a3)
        scratchCtx.putImageData(new ImageData(result,260,260),0,0)
        return scratch
    } 
}

class CanvasPool {
    constructor(tile_size) {
        this.unused = []
        this.tile_size = tile_size
    }

    get() {
        if (this.unused.length) {
            let free = this.unused.shift()
            free.removed = false
            return free
        }
        let element = L.DomUtil.create('canvas', 'leaflet-tile')
        element.width = this.tile_size
        element.height = this.tile_size
        return element
    }

    put(elem) {
        L.DomUtil.removeClass(elem,'leaflet-tile-loaded')
        this.unused.push(elem)
    }
}

class Layer extends L.GridLayer {
    constructor(options) {
        if (options.noWrap && !options.bounds) options.bounds = [[-90,-180],[90,180]]
        super(options)
        this.debug = options.debug
        this.pool = new CanvasPool(256)
        this.source = new ZxySource(options.url)
        this.azimuth = 315
        this.elevation = 45
    }

    rerenderTile(key) {
        for (var unwrapped_k in this._tiles) {
            let wrapped_coord = this._wrapCoords(this._keyToTileCoords(unwrapped_k))
            if (key === this._tileCoordsToKey(wrapped_coord)) {
                this.renderTile(wrapped_coord,this._tiles[unwrapped_k].el,key)
            }
        }
    }

    rerenderTiles() {
        for (var unwrapped_k in this._tiles) {
            let wrapped_coord = this._wrapCoords(this._keyToTileCoords(unwrapped_k))
            let key = this._tileCoordsToKey(wrapped_coord)
            this.renderTile(wrapped_coord,this._tiles[unwrapped_k].el,key)
        }
    }

    async renderTile(coords,element,key,done = ()=>{}) {
        let ctx = element.getContext('2d')
        if (!this._map) return
        var paint_data
        try {
            paint_data = await this.source.get(coords,this.azimuth,this.elevation)
        } catch(e) {
            if (e.name === "AbortError") return
            else throw e
        }
        if (element.key != key) return
        ctx.drawImage(paint_data,2,2,256,256,0,0,256,256)
        if (this.debug) {
            if (!ctx) return
            ctx.save()
            ctx.fillStyle = this.debug
            ctx.font = '600 12px sans-serif'
            ctx.fillText(coords.z + " " + coords.x + " " + coords.y,4,14)
            ctx.strokeStyle = this.debug
            ctx.lineWidth = 0.5
            ctx.strokeRect(0,0,256,256)
            ctx.restore()
        }
        done()
    }

    createTile(coords,showTile) {
        let element = this.pool.get()
        let key = this._tileCoordsToKey(coords)
        element.key = key
        this.renderTile(coords,element,key,() => {
            showTile(null,element)
        })
        return element
    }

    _removeTile(key) {
        var tile = this._tiles[key]
        if (!tile) { return }
        tile.el.removed = true
        tile.el.key = undefined
        L.DomUtil.remove(tile.el)
        this.pool.put(tile.el)
        delete this._tiles[key]
        this.fire('tileunload', {
            tile: tile.el,
            coords: this._keyToTileCoords(key)
        })
    }
}

export { Layer }

export default Layer;