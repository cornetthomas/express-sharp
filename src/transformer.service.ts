import Keyv from 'keyv'
import sharp from 'sharp'
import { singleton } from 'tsyringe'
import { CachedImage } from './cached-image'
import { format, ImageAdapter, Result } from './interfaces'
import { getLogger } from './logger'
import { ObjectHash } from './object-hash.service'
import { ResizeDto } from './resize.dto'
const smartcrop = require('smartcrop-sharp');


const DEFAULT_CROP_MAX_SIZE = 2000

@singleton()
export class Transformer {
  log = getLogger('transformer')
  cropMaxSize = DEFAULT_CROP_MAX_SIZE

  constructor(
    private readonly objectHasher: ObjectHash,
    private readonly cache: Keyv<Result>,
    private readonly cachedOriginalImage: CachedImage,
    private readonly cachedOverlayImage: CachedImage,
  ) {}

  getCropDimensions(maxSize: number, width: number, height?: number): number[] {
    height = height || width

    if (width <= maxSize && height <= maxSize) {
      return [width, height]
    }

    const aspectRatio = width / height

    if (width > height) {
      return [maxSize, Math.round(maxSize / aspectRatio)]
    }

    return [maxSize * aspectRatio, maxSize].map((number) => Math.round(number))
  }

  buildCacheKey(id: string, options: ResizeDto, adapterName: string): string {
    const hash = this.objectHasher.hash(options)
    return `transform:${id}:${adapterName}:${hash}`
  }

  async transform(
    id: string,
    options: ResizeDto,
    imageAdapter: ImageAdapter,
  ): Promise<Result> {
    const cacheKey = this.buildCacheKey(
      id,
      options,
      imageAdapter.constructor.name,
    )

    const cachedImage = await this.cache.get(cacheKey)
    if (cachedImage) {
      this.log(`Serving ${id} from cache ...`)
      return cachedImage
    }

    this.log(`Resizing ${id} with options:`, JSON.stringify(options))

    const originalImage = await this.cachedOriginalImage.fetch(id, imageAdapter)

    if (!originalImage) {
      return {
        format: options.format,
        // eslint-disable-next-line unicorn/no-null
        image: null,
      }
    }


    const transformer = sharp(originalImage).rotate()

    if(options.blur) {
      this.log('Apply blur: ' + options.blurSigma)
      transformer.blur(options.blurSigma) 
    }

    if (!options.format) {
      options.format = (await transformer.metadata()).format as format
    }

    if(options.smartcrop) {
      const [cropWidth, cropHeight] = this.getCropDimensions(
        this.cropMaxSize,
        options.width,
        options.height,
      )
      const result = await smartcrop.crop(originalImage, { width: cropWidth, height: cropHeight })
      const crop = result.topCrop;
      transformer
        .extract({ width: crop.width, height: crop.height, left: crop.x, top: crop.y })
        .resize(cropWidth, cropWidth)
    } else if (options.crop) {
      const [cropWidth, cropHeight] = this.getCropDimensions(
        this.cropMaxSize,
        options.width,
        options.height,
      )
      transformer.resize(cropWidth, cropHeight, {
        position: options.gravity,
      })
    } else {
      transformer.resize(options.width, options.height, {
        fit: 'inside',
        withoutEnlargement: true,
      })
    }

    // Add overlay after cropping
    if(options.overlay) {
      this.log('Applying overlay')
      var overlayImage = await this.cachedOverlayImage.fetch(options.overlayImage, imageAdapter)

      overlayImage = await sharp(overlayImage).resize(200, 200, {fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0.0 },}).flatten({ background: '#ff6600' } ).toBuffer()
    
      if(overlayImage)
         this.log('Overlay image retrieved')
         transformer.composite([{ input: overlayImage, top: 35, left: 35, }])
    }

    const image = await transformer
      .toFormat(options.format, {
        progressive: options.progressive,
        quality: options.quality,
      })
      .toBuffer()

    this.log('Resizing done')

    const result = { format: options.format, image }

    this.log(`Caching ${cacheKey} ...`)
    await this.cache.set(cacheKey, result)
    return result
  }
}
