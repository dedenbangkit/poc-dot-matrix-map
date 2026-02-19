import { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, GeoJSON, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import axios from 'axios';
import * as topojson from 'topojson-client';
import * as turf from '@turf/turf';
import 'leaflet/dist/leaflet.css';
import './index.css';

const INDICATOR_TYPES = [
  { key: 'basic', label: 'Basic Statistics' },
  { key: 'crops', label: 'Crops Grown' },
  { key: 'methods', label: 'Farming Methods' },
];

const BASIC_INDICATORS = [
  { key: 'farmland_hectares', label: 'Farmland (hectares)', format: (v) => v?.toLocaleString() + ' ha' },
  { key: 'annual_yield_tons', label: 'Annual Yield (tons)', format: (v) => v?.toLocaleString() + ' tons' },
  { key: 'farmers_count', label: 'Number of Farmers', format: (v) => v?.toLocaleString() },
  { key: 'rainfall_mm', label: 'Rainfall (mm)', format: (v) => v?.toLocaleString() + ' mm' },
];

const COLOR_SCALE = ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#084594'];

const METHOD_COLORS = {
  conventional: '#8fbc8f',
  organic: '#4a7c59',
  terracing: '#b89860',
  greenhouse: '#7c6b9e',
  hydroponics: '#5a9cb0',
  mechanized: '#d4829c',
  irrigation: '#5080a3',
  agroforestry: '#7ba35a',
  urban_farming: '#c45c5c',
  vertical_farming: '#509e95',
};

function FitBounds({ geoJsonData }) {
  const map = useMap();
  useEffect(() => {
    if (geoJsonData) {
      const geoJsonLayer = L.geoJSON(geoJsonData);
      const bounds = geoJsonLayer.getBounds();
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [map, geoJsonData]);
  return null;
}

function getColor(value, min, max) {
  if (value === undefined || value === null || isNaN(value)) return '#ccc';
  if (max === min) return COLOR_SCALE[4];
  const ratio = (value - min) / (max - min);
  const index = Math.min(Math.floor(ratio * COLOR_SCALE.length), COLOR_SCALE.length - 1);
  return COLOR_SCALE[index];
}

function formatName(name) {
  return name?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || '';
}

function generateDotMatrix(feature, farmingMethods, cellSize = 0.01) {
  try {
    const bbox = turf.bbox(feature);

    // Use hex grid for honeycomb pattern (no gaps, radial look)
    const hexGrid = turf.hexGrid(bbox, cellSize, { units: 'degrees' });

    // Get centroids of hex cells that intersect with polygon, with random jitter
    const jitterAmount = cellSize * 0.7;
    const pointsInPolygon = [];

    hexGrid.features.forEach((hex) => {
      try {
        const centroid = turf.centroid(hex);
        // Add random jitter to position
        const jitteredLng = centroid.geometry.coordinates[0] + (Math.random() - 0.5) * jitterAmount;
        const jitteredLat = centroid.geometry.coordinates[1] + (Math.random() - 0.5) * jitterAmount;
        const jitteredPoint = turf.point([jitteredLng, jitteredLat]);

        if (turf.booleanPointInPolygon(jitteredPoint, feature)) {
          pointsInPolygon.push(jitteredPoint);
        } else if (turf.booleanPointInPolygon(centroid, feature)) {
          // Fallback to original centroid if jittered point is outside
          pointsInPolygon.push(centroid);
        }
      } catch {
        // Skip invalid geometries
      }
    });

    if (pointsInPolygon.length === 0 || !farmingMethods || farmingMethods.length === 0) {
      return [];
    }

    const total = farmingMethods.reduce((sum, m) => sum + m.value, 0);
    const methodProportions = farmingMethods.map((m) => ({
      name: m.name,
      proportion: m.value / total,
      color: METHOD_COLORS[m.name] || '#999',
    }));

    // Shuffle points for random color distribution
    const shuffledIndices = pointsInPolygon.map((_, i) => i).sort(() => Math.random() - 0.5);

    const dots = [];
    shuffledIndices.forEach((originalIndex, newIndex) => {
      const point = pointsInPolygon[originalIndex];
      const ratio = newIndex / pointsInPolygon.length;
      let assignedMethod = methodProportions[methodProportions.length - 1];

      let cumulative = 0;
      for (const method of methodProportions) {
        cumulative += method.proportion;
        if (ratio < cumulative) {
          assignedMethod = method;
          break;
        }
      }

      dots.push({
        coordinates: point.geometry.coordinates,
        method: assignedMethod.name,
        color: assignedMethod.color,
      });
    });

    return dots;
  } catch (error) {
    console.error('Error generating dot matrix:', error);
    return [];
  }
}

function App() {
  const [topoData, setTopoData] = useState(null);
  const [agriData, setAgriData] = useState(null);
  const [indicatorType, setIndicatorType] = useState('basic');
  const [selectedIndicator, setSelectedIndicator] = useState('farmland_hectares');
  const [hoveredRegion, setHoveredRegion] = useState(null);
  const [geoKey, setGeoKey] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      const [topoRes, agriRes] = await Promise.all([
        axios.get(`${import.meta.env.BASE_URL}data/west-java.json`),
        axios.get(`${import.meta.env.BASE_URL}data/west-java-agri-data.json`),
      ]);
      setTopoData(topoRes.data);
      setAgriData(agriRes.data);
    };
    fetchData();
  }, []);

  const geoJsonData = useMemo(() => {
    if (!topoData) return null;
    const objectName = Object.keys(topoData.objects)[0];
    return topojson.feature(topoData, topoData.objects[objectName]);
  }, [topoData]);

  const agriDataMap = useMemo(() => {
    if (!agriData) return {};
    return agriData.data.reduce((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {});
  }, [agriData]);

  // Get unique crops from data
  const cropsIndicators = useMemo(() => {
    if (!agriData) return [];
    const cropsSet = new Set();
    agriData.data.forEach((d) => {
      d.crops_grown?.forEach((c) => cropsSet.add(c.name));
    });
    return Array.from(cropsSet).map((name) => ({
      key: name,
      label: formatName(name),
      format: (v) => (v ? v.toLocaleString() + ' tons' : 'N/A'),
    }));
  }, [agriData]);

  // Get unique farming methods from data
  const uniqueMethods = useMemo(() => {
    if (!agriData) return [];
    const methodsSet = new Set();
    agriData.data.forEach((d) => {
      d.farming_methods?.forEach((m) => methodsSet.add(m.name));
    });
    return Array.from(methodsSet);
  }, [agriData]);

  // Get current indicators based on type
  const currentIndicators = useMemo(() => {
    if (indicatorType === 'basic') return BASIC_INDICATORS;
    if (indicatorType === 'crops') return cropsIndicators;
    return [];
  }, [indicatorType, cropsIndicators]);

  // Reset selected indicator when type changes
  useEffect(() => {
    if (indicatorType !== 'methods' && currentIndicators.length > 0) {
      setSelectedIndicator(currentIndicators[0].key);
    }
  }, [indicatorType, currentIndicators]);

  // Get value for a region based on indicator type
  const getValue = (data, indicator) => {
    if (!data) return null;
    if (indicatorType === 'basic') {
      return data[indicator];
    }
    if (indicatorType === 'crops') {
      const crop = data.crops_grown?.find((c) => c.name === indicator);
      return crop?.value ?? null;
    }
    return null;
  };

  const { min, max } = useMemo(() => {
    if (!agriData || indicatorType === 'methods') return { min: 0, max: 1 };
    const values = agriData.data
      .map((d) => getValue(d, selectedIndicator))
      .filter((v) => v !== undefined && v !== null);
    if (values.length === 0) return { min: 0, max: 1 };
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [agriData, selectedIndicator, indicatorType]);

  // Generate dot matrix for all regions
  const dotMatrixData = useMemo(() => {
    if (indicatorType !== 'methods' || !geoJsonData || !agriData) return [];

    const allDots = [];
    geoJsonData.features.forEach((feature) => {
      const regionData = agriDataMap[feature.id];
      if (regionData?.farming_methods) {
        const dots = generateDotMatrix(feature, regionData.farming_methods);
        dots.forEach((dot) => {
          allDots.push({
            ...dot,
            regionId: feature.id,
            kabkot: regionData.kabkot,
          });
        });
      }
    });
    return allDots;
  }, [indicatorType, geoJsonData, agriData, agriDataMap]);

  useEffect(() => {
    setGeoKey((k) => k + 1);
  }, [selectedIndicator, geoJsonData, indicatorType]);

  const indicator = currentIndicators.find((i) => i.key === selectedIndicator) || currentIndicators[0];

  const choroplethStyle = (feature) => {
    if (indicatorType === 'methods') {
      return {
        fillColor: 'transparent',
        weight: 2,
        opacity: 1,
        color: '#555',
        fillOpacity: 0,
      };
    }
    const data = agriDataMap[feature.id];
    const value = getValue(data, selectedIndicator);
    return {
      fillColor: getColor(value, min, max),
      weight: 1,
      opacity: 1,
      color: '#666',
      fillOpacity: 0.8,
    };
  };

  const onEachFeature = (feature, layer) => {
    const data = agriDataMap[feature.id];
    layer.on({
      mouseover: () => {
        setHoveredRegion({ ...feature.properties, ...data });
        layer.setStyle({ weight: 3, color: '#222' });
        layer.bringToFront();
      },
      mouseout: () => {
        setHoveredRegion(null);
        layer.setStyle({ weight: indicatorType === 'methods' ? 2 : 1, color: indicatorType === 'methods' ? '#555' : '#666' });
      },
    });
  };

  const legendItems = useMemo(() => {
    if (indicatorType === 'methods' || !indicator) return [];
    const step = (max - min) / 5;
    return Array.from({ length: 5 }, (_, i) => ({
      color: COLOR_SCALE[Math.floor((i / 5) * COLOR_SCALE.length) + 1],
      label: indicator.format(Math.round(min + step * i)) + ' - ' + indicator.format(Math.round(min + step * (i + 1))),
    }));
  }, [min, max, indicator, indicatorType]);

  if (!geoJsonData || !agriData) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>Loading...</div>;
  }

  const hoveredValue = hoveredRegion && indicatorType !== 'methods' ? getValue(hoveredRegion, selectedIndicator) : null;

  return (
    <div className="map-container">
      <MapContainer
        center={[-6.9, 107.6]}
        zoom={8}
        zoomControl={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        dragging={false}
        attributionControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
        />
        <FitBounds geoJsonData={geoJsonData} />
        <GeoJSON
          key={geoKey}
          data={geoJsonData}
          style={choroplethStyle}
          onEachFeature={onEachFeature}
        />
        {indicatorType === 'methods' && dotMatrixData.map((dot, index) => (
          <CircleMarker
            key={index}
            center={[dot.coordinates[1], dot.coordinates[0]]}
            radius={3}
            fillColor={dot.color}
            color={dot.color}
            weight={0}
            fillOpacity={1}
          />
        ))}
      </MapContainer>

      <div className="indicator-dropdown">
        <label>Indicator Type</label>
        <select value={indicatorType} onChange={(e) => setIndicatorType(e.target.value)}>
          {INDICATOR_TYPES.map((type) => (
            <option key={type.key} value={type.key}>{type.label}</option>
          ))}
        </select>

        {indicatorType !== 'methods' && (
          <>
            <label style={{ marginTop: 12 }}>Select Indicator</label>
            <select value={selectedIndicator} onChange={(e) => setSelectedIndicator(e.target.value)}>
              {currentIndicators.map((ind) => (
                <option key={ind.key} value={ind.key}>{ind.label}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {hoveredRegion && (
        <div className="info-panel">
          <h3>{hoveredRegion.kabkot}</h3>
          <p>{hoveredRegion.description}</p>
          {indicatorType === 'methods' ? (
            <div>
              <p style={{ fontWeight: 600, marginBottom: 4 }}>Farming Methods:</p>
              {hoveredRegion.farming_methods?.map((m) => (
                <p key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      backgroundColor: METHOD_COLORS[m.name] || '#999',
                      display: 'inline-block',
                    }}
                  />
                  {formatName(m.name)}: <span className="value">{m.value.toLocaleString()} ha</span>
                </p>
              ))}
            </div>
          ) : (
            <>
              <p>
                {indicator?.label}: <span className="value">{indicator?.format(hoveredValue)}</span>
              </p>
              <p>Primary Crop: <span className="value">{formatName(hoveredRegion.primary_crop)}</span></p>
              <p>Soil Type: <span className="value">{formatName(hoveredRegion.soil_type)}</span></p>
            </>
          )}
        </div>
      )}

      {indicatorType === 'methods' ? (
        <div className="legend">
          <div className="legend-title">Farming Methods</div>
          {uniqueMethods.map((method) => (
            <div key={method} className="legend-item">
              <div
                className="legend-color circle"
                style={{ backgroundColor: METHOD_COLORS[method] || '#999' }}
              />
              <span>{formatName(method)}</span>
            </div>
          ))}
        </div>
      ) : indicator && (
        <div className="legend">
          <div className="legend-title">{indicator.label}</div>
          {legendItems.map((item, i) => (
            <div key={i} className="legend-item">
              <div className="legend-color" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
