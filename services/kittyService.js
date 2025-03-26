const axios = require("axios");

// 1. Create a configurable client factory
const createApiClient = (baseURL) => {
  return axios.create({
    baseURL: `${baseURL}/api`,
    headers: {
      'x-api-key': process.env.API_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
};

// 2. Service functions with dependency injection
const createKittyService = (KITTY_BACKEND) => {
  const client = createApiClient(KITTY_BACKEND);

  const uploadPhotosFromTelegram = async (validUploads) => {
    console.log('Files:', validUploads.map(v => v.filename));
    
    try {
      const { data } = await client.post('/kittys/images', { 
        photos: validUploads 
      });
      return data;
    } catch (error) {
      console.error('Upload failed:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      throw error;
    }
  };

  const uploadDocumentsFromTelegram = async (publicIds, validUploads) => {
    const requests = publicIds.map((public_id, index) => 
      client.post('/kittys', {
        image_id: public_id,
        quote: validUploads[index].caption,
        hour: new Date().toISOString()
      }).catch(e => {
        console.error(`Failed ${public_id}:`, e.message);
        return null;
      })
    );

    const results = await Promise.all(requests);
    return results.filter(Boolean).map(r => r.data);
  };

  return {
    uploadPhotosFromTelegram,
    uploadDocumentsFromTelegram
  };
};

module.exports = createKittyService;