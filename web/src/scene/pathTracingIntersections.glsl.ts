// One RGBA32F texture contains preorder nodes followed by three texels per cylinder.
// Analytic hits keep the existing SurfaceHit ABI: x = material, y = color texel + 1
// (0 for white), w = reserved tag, barycoord = OUTWARD normal. No BSDF/RNG changes.
export const PRIMITIVE_INTERSECTION_GLSL = /* glsl */`
  #ifndef CRYSTAL_HAS_TRIANGLES
  #define CRYSTAL_HAS_TRIANGLES 1
  #endif
  uniform sampler2D crystalPrimitiveNodes;
  uniform int crystalPrimitiveNodeCount;
  const uint CRYSTAL_ANALYTIC_HIT = 0xffffffffu;

  uint crystalMaterialIndex(usampler2D indexTexture, uvec4 faceIndices) {
    return faceIndices.w == CRYSTAL_ANALYTIC_HIT ? faceIndices.x : uTexelFetch1D(indexTexture, faceIndices.x).r;
  }

  vec4 crystalAttribute(sampler2DArray attributes, int layer, uvec4 faceIndices, vec3 barycoord) {
    if (faceIndices.w != CRYSTAL_ANALYTIC_HIT) {
      return textureSampleBarycoord(attributes, layer, barycoord, faceIndices.xyz);
    }
    // Textured and flat-shaded shapes are not extracted. Bond vertex colors stay linear.
    if (layer == ATTR_NORMAL) return vec4(barycoord, 0.0);
    if (layer == ATTR_COLOR) {
      return faceIndices.y == 0u ? vec4(1.0) : vec4(texelFetch1D(crystalPrimitiveNodes, faceIndices.y - 1u).rgb, 1.0);
    }
    return vec4(0.0);
  }

  bool crystalBoundsHit(vec3 origin, vec3 direction, vec3 lower, vec3 upper, float closest) {
    float nearDistance = 0.0;
    float farDistance = closest;
    for (int axis = 0; axis < 3; axis++) {
      if (direction[axis] == 0.0) {
        if (origin[axis] < lower[axis] || origin[axis] > upper[axis]) return false;
      } else {
        float a = (lower[axis] - origin[axis]) / direction[axis];
        float b = (upper[axis] - origin[axis]) / direction[axis];
        nearDistance = max(nearDistance, min(a, b));
        farDistance = min(farDistance, max(a, b));
        if (farDistance < nearDistance) return false;
      }
    }
    return farDistance >= nearDistance;
  }

  vec2 crystalQuadraticRoots(float a, float b, float c, float discriminant) {
    float root = sqrt(discriminant);
    float q = -b - (b < 0.0 ? -root : root);
    float t0 = q / a;
    float t1 = q == 0.0 ? -b / a : c / q;
    return vec2(min(t0, t1), max(t0, t1));
  }

  bool crystalSphereHit(vec3 origin, vec3 direction, vec4 sphere, out float distance) {
    distance = INFINITY;
    vec3 offset = origin - sphere.xyz;
    float a = dot(direction, direction);
    float b = dot(offset, direction);
    // Closest-approach discriminant and q-form roots retain grazing / near-surface hits.
    // See PBRT 4e, Shapes / Spheres. No tessellation or marching steps are involved.
    float perpendicular = length(offset - direction * (b / a));
    float discriminant = a * (sphere.w + perpendicular) * (sphere.w - perpendicular);
    if (discriminant < 0.0) return false;
    float offsetLength = length(offset);
    vec2 roots = crystalQuadraticRoots(a, b, (offsetLength - sphere.w) * (offsetLength + sphere.w), discriminant);
    distance = roots.x > 0.0 ? roots.x : roots.y;
    return distance > 0.0;
  }

  bool crystalCylinderHit(vec3 origin, vec3 direction, vec3 center, float radius,
    vec4 axisAndLength, bool capped, out float distance, out vec3 outward, out float along) {
    vec3 axis = normalize(axisAndLength.xyz);
    float halfLength = axisAndLength.w;
    vec3 offset = origin - center;
    float originAlong = dot(offset, axis);
    float directionAlong = dot(direction, axis);
    vec3 radialOrigin = offset - axis * originAlong;
    vec3 radialDirection = direction - axis * directionAlong;
    float a = dot(radialDirection, radialDirection);
    distance = INFINITY;
    outward = vec3(0.0);
    along = 0.0;
    // Parallel axial rays miss the side; only the original capped cylinders can hit an end.
    if (a > 0.0) {
      float b = dot(radialOrigin, radialDirection);
      float perpendicular = length(radialOrigin - radialDirection * (b / a));
      float discriminant = a * (radius + perpendicular) * (radius - perpendicular);
      if (discriminant >= 0.0) {
        float radialLength = length(radialOrigin);
        vec2 roots = crystalQuadraticRoots(a, b, (radialLength - radius) * (radialLength + radius), discriminant);
        for (int root = 0; root < 2; root++) {
          float candidate = roots[root];
          float height = originAlong + candidate * directionAlong;
          if (candidate > 0.0 && candidate < distance && abs(height) <= halfLength) {
            distance = candidate;
            outward = normalize(radialOrigin + radialDirection * candidate);
            along = height;
          }
        }
      }
    }
    if (capped && directionAlong != 0.0) {
      for (int cap = 0; cap < 2; cap++) {
        float capSide = cap == 0 ? -1.0 : 1.0;
        float height = capSide * halfLength;
        float candidate = (height - originAlong) / directionAlong;
        vec3 radial = radialOrigin + radialDirection * candidate;
        if (candidate > 0.0 && candidate < distance && dot(radial, radial) <= radius * radius) {
          distance = candidate;
          outward = axis * capSide;
          along = height;
        }
      }
    }
    return distance < INFINITY;
  }

  bool crystalIntersectFirstHit(vec3 origin, vec3 direction,
    inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord, inout float side, inout float distance) {
    // Keep the sampler-containing BVH global, matching the vendor's cross-driver workaround.
    #if CRYSTAL_HAS_TRIANGLES
      bool found = bvhIntersectFirstHit(bvh, origin, direction, faceIndices, faceNormal, barycoord, side, distance);
    #else
      bool found = false;
      distance = INFINITY;
    #endif
    float closest = found ? distance : INFINITY;
    int node = 0;
    while (node < crystalPrimitiveNodeCount) {
      vec4 a = texelFetch1D(crystalPrimitiveNodes, uint(node * 2));
      vec4 b = texelFetch1D(crystalPrimitiveNodes, uint(node * 2 + 1));
      if (a.w == 0.0) {
        node = crystalBoundsHit(origin, direction, a.xyz, b.xyz, closest) ? node + 1 : int(b.w);
      } else {
        float primitiveDistance;
        vec3 outward;
        uint colorTexel = 0u;
        bool hit;
        if (a.w > 0.0) {
          hit = crystalSphereHit(origin, direction, a, primitiveDistance);
          if (hit) outward = normalize(origin - a.xyz + direction * primitiveDistance);
        } else {
          uint extra = uint(crystalPrimitiveNodeCount * 2) + uint(b.z) * 3u;
          vec4 axisAndLength = texelFetch1D(crystalPrimitiveNodes, extra);
          bool capped = texelFetch1D(crystalPrimitiveNodes, extra + 1u).w != 0.0;
          float along;
          hit = crystalCylinderHit(origin, direction, a.xyz, -a.w, axisAndLength, capped, primitiveDistance, outward, along);
          // The original bond has a hard boundary at local y = 0, not an interpolated gradient.
          colorTexel = extra + (along <= 0.0 ? 1u : 2u) + 1u;
        }
        if (hit && primitiveDistance < closest) {
          side = dot(direction, outward) <= 0.0 ? 1.0 : -1.0;
          faceNormal = outward * side;
          barycoord = outward;
          faceIndices = uvec4(uint(b.x), colorTexel, 0u, CRYSTAL_ANALYTIC_HIT);
          closest = primitiveDistance;
          found = true;
        }
        node++;
      }
    }
    distance = closest;
    return found;
  }
`;
