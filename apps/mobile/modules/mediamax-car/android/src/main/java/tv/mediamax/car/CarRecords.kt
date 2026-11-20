package tv.mediamax.car

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** A row of the browse tree, as sent by JS (`modules/mediamax-car/index.ts` > `CarNode`). */
class CarNodeRecord : Record {
  @Field val id: String = ""
  @Field val title: String = ""
  @Field val subtitle: String? = null
  @Field val artworkUrl: String? = null
  /** SF Symbol name for CarPlay tabs; unused on Android. */
  @Field val icon: String? = null
  @Field val group: String? = null
  @Field val browsable: Boolean = false
  @Field val playable: Boolean = false
  @Field val progress: Double? = null
  @Field val playing: Boolean = false
  @Field val mediaType: String? = null
}

/** Mirror of the phone player (`CarNowPlaying` in JS). */
class NowPlayingRecord : Record {
  @Field val id: String? = null
  @Field val title: String = ""
  @Field val subtitle: String? = null
  @Field val album: String? = null
  @Field val artworkUrl: String? = null
  @Field val durationMs: Double = 0.0
  @Field val positionMs: Double = 0.0
  @Field val playing: Boolean = false
  @Field val buffering: Boolean = false
  @Field val spoken: Boolean = false
  @Field val rate: Double = 1.0
  @Field val hasNext: Boolean = false
  @Field val hasPrevious: Boolean = false
  @Field val queueLength: Int = 0
  @Field val error: String? = null
}
